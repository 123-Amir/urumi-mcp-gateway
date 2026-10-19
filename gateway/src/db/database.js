// SQLite persistence (node:sqlite, built into Node 22 => no native build step in Docker).
// One gateway replica owns the file on a PVC. Limitation: not multi-writer; scaling out would need Postgres.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { hashApiKey, generateApiKey, looksLikeApiKey } from '../security/apikeys.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member')),
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auth_type TEXT NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','bearer','header')),
  auth_header_name TEXT, credential_enc TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
  user_id TEXT, user_email TEXT, source TEXT NOT NULL,       -- source: 'mcp' | 'chat'
  server_slug TEXT, tool TEXT, duration_ms INTEGER,
  success INTEGER NOT NULL, error_summary TEXT);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
`;

const now = () => new Date().toISOString();
const SLUG_RE = /^[a-z][a-z0-9-]{1,29}$/; // no "__" possible => "<slug>__<tool>" splits unambiguously

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return makeRepo(db);
}

function makeRepo(db) {
  const q = (sql) => db.prepare(sql); // prepared statements only: values are bound, never string-concatenated (SQL injection)
  return {
    raw: db,
    close: () => db.close(),

    // ---------- users ----------
    createUser({ email, name, role }) {
      if (!['admin', 'member'].includes(role)) throw new Error('invalid role');
      const u = { id: randomUUID(), email: email.trim().toLowerCase(), name: name.trim(), role, disabled: 0, created_at: now() };
      q('INSERT INTO users (id,email,name,role,disabled,created_at) VALUES (?,?,?,?,?,?)')
        .run(u.id, u.email, u.name, u.role, 0, u.created_at);
      return u;
    },
    getUser: (id) => q('SELECT * FROM users WHERE id=?').get(id),
    getUserByEmail: (e) => q('SELECT * FROM users WHERE email=?').get(String(e).trim().toLowerCase()),
    listUsers: () => q('SELECT * FROM users ORDER BY created_at').all(),
    countAdmins: () => q("SELECT COUNT(*) c FROM users WHERE role='admin' AND disabled=0").get().c,
    setUserDisabled: (id, d) => q('UPDATE users SET disabled=? WHERE id=?').run(d ? 1 : 0, id),
    setUserRole: (id, role) => q('UPDATE users SET role=? WHERE id=?').run(role, id),

    // ---------- api keys ----------
    // Returns the raw key exactly once; DB only keeps the hash.
    issueKey(userId, label) {
      const k = generateApiKey();
      const id = randomUUID();
      q('INSERT INTO api_keys (id,user_id,label,prefix,key_hash,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, userId, label.trim().slice(0, 60), k.prefix, k.hash, now());
      return { id, raw: k.raw, prefix: k.prefix };
    },
    // Auth lookup: hash the presented key, find it. Revoked keys / disabled users yield null => 401.
    authenticate(rawKey) {
      if (!looksLikeApiKey(rawKey)) return null;
      const row = q(`SELECT k.id key_id, k.revoked_at, u.* FROM api_keys k JOIN users u ON u.id=k.user_id
                     WHERE k.key_hash=?`).get(hashApiKey(rawKey));
      if (!row || row.revoked_at || row.disabled) return null;
      q('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), row.key_id);
      return { id: row.id, email: row.email, name: row.name, role: row.role, keyId: row.key_id };
    },
    listKeys: (userId) => q('SELECT id,user_id,label,prefix,created_at,last_used_at,revoked_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC').all(userId),
    getKey: (id) => q('SELECT id,user_id,label,prefix,created_at,last_used_at,revoked_at FROM api_keys WHERE id=?').get(id),
    revokeKey: (id) => q('UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(), id).changes > 0,
    revokeAllKeysForUser: (uid) => q('UPDATE api_keys SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now(), uid).changes,

    // Seed first admin from a key provided via Kubernetes Secret (so no raw key is ever logged).
    bootstrapAdmin({ email, rawKey }) {
      if (this.countAdmins() > 0) return false;
      if (!looksLikeApiKey(rawKey)) throw new Error('BOOTSTRAP_ADMIN_API_KEY has invalid format (umk_xxxxxxxx_<43 chars>)');
      const u = this.getUserByEmail(email) ?? this.createUser({ email, name: 'Admin', role: 'admin' });
      q('INSERT INTO api_keys (id,user_id,label,prefix,key_hash,created_at) VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), u.id, 'bootstrap', rawKey.slice(0, 12), hashApiKey(rawKey), now());
      return true;
    },

    // ---------- servers ----------
    createServer({ slug, name, url, enabled = true, authType = 'none', authHeaderName = null, credentialEnc = null }) {
      if (!SLUG_RE.test(slug)) throw new Error('slug must match ^[a-z][a-z0-9-]{1,29}$');
      const t = now(); const id = randomUUID();
      q(`INSERT INTO servers (id,slug,name,url,enabled,auth_type,auth_header_name,credential_enc,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, slug, name.trim(), url, enabled ? 1 : 0, authType, authHeaderName, credentialEnc, t, t);
      return this.getServer(id);
    },
    getServer: (id) => q('SELECT * FROM servers WHERE id=?').get(id),
    getServerBySlug: (s) => q('SELECT * FROM servers WHERE slug=?').get(s),
    listServers: () => q('SELECT * FROM servers ORDER BY created_at').all(),
    listEnabledServers: () => q('SELECT * FROM servers WHERE enabled=1 ORDER BY created_at').all(),
    updateServer(id, patch) {
      const cur = this.getServer(id); if (!cur) return null;
      const m = { ...cur, ...patch, updated_at: now() };
      q(`UPDATE servers SET name=?,url=?,enabled=?,auth_type=?,auth_header_name=?,credential_enc=?,updated_at=? WHERE id=?`)
        .run(m.name, m.url, m.enabled ? 1 : 0, m.auth_type, m.auth_header_name, m.credential_enc, m.updated_at, id);
      return this.getServer(id);
    },
    deleteServer: (id) => q('DELETE FROM servers WHERE id=?').run(id).changes > 0,

    // ---------- audit ----------
    audit(e) {
      q(`INSERT INTO audit_logs (ts,user_id,user_email,source,server_slug,tool,duration_ms,success,error_summary)
         VALUES (?,?,?,?,?,?,?,?,?)`).run(now(), e.userId ?? null, e.userEmail ?? null, e.source, e.serverSlug ?? null,
        e.tool ?? null, e.durationMs ?? null, e.success ? 1 : 0, e.errorSummary ? String(e.errorSummary).slice(0, 300) : null);
    },
    listAudit({ userId, limit = 100, offset = 0 } = {}) {
      const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
      const off = Math.max(Number(offset) || 0, 0);
      return userId
        ? q('SELECT * FROM audit_logs WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(userId, lim, off)
        : q('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(lim, off);
    },
  };
}
