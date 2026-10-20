// SQLite persistence (node:sqlite, built into Node 22 => no native build step in Docker).
// One gateway replica owns the file on a PVC. Limitation: not multi-writer; scaling out would need Postgres.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
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
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                       -- sha256(session token); raw token only lives in the browser cookie
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,  -- the API key used to log in
  csrf TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(key_id);
CREATE TABLE IF NOT EXISTS tool_rules (        -- deny-rules; default is allow. Admins bypass rules.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('role','user')), subject TEXT NOT NULL,
  server_slug TEXT NOT NULL, tool TEXT NOT NULL,          -- tool '*' = every tool of that server
  created_at TEXT NOT NULL, UNIQUE(subject_type, subject, server_slug, tool));
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
`;

const sha = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
const SLUG_RE = /^[a-z][a-z0-9-]{1,29}$/; // no "__" possible => "<slug>__<tool>" splits unambiguously

// clock is injectable so tests can fast-forward time to prove session expiry (no sleeping in tests).
export function openDb(path, { clock = () => new Date() } = {}) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return makeRepo(db, () => clock().toISOString());
}

function makeRepo(db, now) {
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

    // ---------- sessions (dashboard login) ----------
    // Cookie holds a random token; DB holds only its hash. A session is bound to the API key that
    // created it, so revoking that key (or disabling the user) kills the session on the very next request.
    createSession({ userId, keyId, ttlMs }) {
      const token = randomBytes(32).toString('base64url');
      const csrf = randomBytes(24).toString('base64url');
      const t = now();
      const expiresAt = new Date(Date.parse(t) + ttlMs).toISOString();
      q('INSERT INTO sessions (id,user_id,key_id,csrf,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .run(sha(token), userId, keyId, csrf, t, t, expiresAt);
      return { token, csrf, expiresAt };
    },
    getSession(token, idleMs) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
      const id = sha(token);
      const r = q(`SELECT s.*, k.revoked_at key_revoked, u.email, u.name, u.role, u.disabled
                   FROM sessions s JOIN api_keys k ON k.id=s.key_id JOIN users u ON u.id=s.user_id WHERE s.id=?`).get(id);
      if (!r) return null;
      const t = Date.parse(now());
      const dead = Date.parse(r.expires_at) <= t || t - Date.parse(r.last_seen_at) > idleMs || r.key_revoked || r.disabled;
      if (dead) { q('DELETE FROM sessions WHERE id=?').run(id); return null; }
      q('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now(), id);
      // role is read LIVE from users table, so a demotion applies immediately to existing sessions
      return { sessionId: id, csrf: r.csrf, expiresAt: r.expires_at,
               user: { id: r.user_id, email: r.email, name: r.name, role: r.role, keyId: r.key_id } };
    },
    deleteSession: (token) => q('DELETE FROM sessions WHERE id=?').run(sha(token)).changes > 0,
    deleteSessionsForKey: (keyId) => q('DELETE FROM sessions WHERE key_id=?').run(keyId).changes,
    deleteSessionsForUser: (uid) => q('DELETE FROM sessions WHERE user_id=?').run(uid).changes,
    purgeExpiredSessions: () => q('DELETE FROM sessions WHERE expires_at <= ?').run(now()).changes,
    countSessions: () => q('SELECT COUNT(*) c FROM sessions').get().c,

    // ---------- tool rules (per-role / per-user deny list) ----------
    addToolRule({ subjectType, subject, serverSlug, tool }) {
      q('INSERT INTO tool_rules (subject_type,subject,server_slug,tool,created_at) VALUES (?,?,?,?,?)')
        .run(subjectType, subject, serverSlug, tool, now());
    },
    listToolRules: () => q('SELECT * FROM tool_rules ORDER BY id').all(),
    deleteToolRule: (id) => q('DELETE FROM tool_rules WHERE id=?').run(id).changes > 0,
    deleteToolRulesForServer: (slug) => q('DELETE FROM tool_rules WHERE server_slug=?').run(slug).changes,
    isToolDenied(user, slug, tool) {
      if (user.role === 'admin') return false; // admins can never lock themselves out
      return q(`SELECT 1 FROM tool_rules WHERE server_slug=? AND tool IN (?, '*')
                AND ((subject_type='role' AND subject=?) OR (subject_type='user' AND subject=?)) LIMIT 1`)
        .get(slug, tool, user.role, user.id) !== undefined;
    },

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
