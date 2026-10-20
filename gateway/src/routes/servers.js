import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../http/middleware.js';
import { serializeServer } from '../http/serializers.js';
import { assertSafeUpstreamUrl } from '../security/ssrf.js';
import { encrypt } from '../security/secretbox.js';

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'transfer-encoding', 'connection', 'upgrade', 'te', 'cookie', 'mcp-session-id', 'mcp-protocol-version']);
const credential = z.string().min(1).max(4096).regex(/^[\x20-\x7E]+$/, 'credential must be printable ASCII (no newlines)');
const headerName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/).refine((h) => !FORBIDDEN_HEADERS.has(h.toLowerCase()), 'header name not allowed');
const create = z.object({
  slug: z.string(), name: z.string().min(1).max(80), url: z.string().max(500), enabled: z.boolean().default(true),
  authType: z.enum(['none', 'bearer', 'header']).default('none'), authHeaderName: headerName.optional(), credential: credential.optional(),
}).strict();
const patch = z.object({
  name: z.string().min(1).max(80), url: z.string().max(500), enabled: z.boolean(),
  authType: z.enum(['none', 'bearer', 'header']), authHeaderName: headerName.nullable(), credential: credential.nullable(),
}).partial().strict();

export function serverRoutes({ db, config, manager, logger, mw }) {
  const r = Router();
  const view = (s) => serializeServer(s, manager.describe(s));
  const checkUrl = (u) => assertSafeUpstreamUrl(u, config.upstream);
  const checkAuthShape = (type, hdr, cred) => {
    if (type === 'none') return;
    if (!cred) { const e = new Error('credential is required for this authType'); e.status = 400; throw e; }
    if (type === 'header' && !hdr) { const e = new Error('authHeaderName is required for authType "header"'); e.status = 400; throw e; }
  };

  r.use(mw.requireRole('admin')); // EVERY route in this file is admin-only, enforced here on the server

  r.get('/', (req, res) => res.json({ servers: db.listServers().map(view) }));

  r.post('/', ah(async (req, res) => {
    const b = create.parse(req.body);
    await checkUrl(b.url);
    checkAuthShape(b.authType, b.authHeaderName, b.credential);
    let s;
    try {
      s = db.createServer({ slug: b.slug, name: b.name, url: b.url, enabled: b.enabled, authType: b.authType,
        authHeaderName: b.authType === 'header' ? b.authHeaderName : null,
        credentialEnc: b.authType === 'none' ? null : encrypt(b.credential, config.encryptionKey) });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'slug_taken' });
      if (/slug must match/.test(e.message)) return res.status(400).json({ error: 'bad_request', message: e.message });
      throw e;
    }
    await manager.refreshServer(s); // bounded by timeouts; response shows real status
    logger.info('server_created', { by: req.auth.user.id, server: s.slug });
    res.status(201).json({ server: view(s) });
  }));

  r.patch('/:id', ah(async (req, res) => {
    const cur = db.getServer(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not_found' });
    const b = patch.parse(req.body); // slug is NOT editable: it is the tool namespace clients depend on
    const next = { name: b.name ?? cur.name, url: b.url ?? cur.url, enabled: b.enabled ?? !!cur.enabled,
      auth_type: b.authType ?? cur.auth_type, auth_header_name: b.authHeaderName !== undefined ? b.authHeaderName : cur.auth_header_name, credential_enc: cur.credential_enc };
    if (b.url !== undefined) await checkUrl(b.url);
    if (b.credential !== undefined) next.credential_enc = b.credential === null ? null : encrypt(b.credential, config.encryptionKey);
    if (next.auth_type === 'none') { next.credential_enc = null; next.auth_header_name = null; }
    else checkAuthShape(next.auth_type, next.auth_header_name, next.credential_enc);
    if (next.auth_type !== 'header') next.auth_header_name = null;
    const s = db.updateServer(cur.id, next);
    manager.invalidate(cur.id);               // drop old connection => new url/credential/enabled takes effect now
    if (s.enabled) await manager.refreshServer(s);
    logger.info('server_updated', { by: req.auth.user.id, server: s.slug });
    res.json({ server: view(s) });
  }));

  r.post('/:id/refresh', ah(async (req, res) => {
    const s = db.getServer(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    await manager.refreshServer(s);
    res.json({ server: view(s) });
  }));

  r.delete('/:id', (req, res) => {
    const s = db.getServer(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    db.deleteServer(s.id); db.deleteToolRulesForServer(s.slug); manager.invalidate(s.id);
    logger.info('server_deleted', { by: req.auth.user.id, server: s.slug });
    res.status(204).end();
  });
  return r;
}
