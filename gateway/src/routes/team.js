import { Router } from 'express';
import { z } from 'zod';
import { serializeUser, serializeKey } from '../http/serializers.js';

const MAX_ACTIVE_KEYS = 10;
export function teamRoutes({ db, logger, mw }) {
  const users = Router(), keys = Router();
  const admin = mw.requireRole('admin');

  // ---- users (admin only) ----
  users.get('/', admin, (req, res) => res.json({ users: db.listUsers().map(serializeUser) }));
  users.post('/', admin, (req, res) => {
    const b = z.object({ email: z.string().email().max(120), name: z.string().min(1).max(80), role: z.enum(['admin', 'member']).default('member') }).strict().parse(req.body);
    if (db.getUserByEmail(b.email)) return res.status(409).json({ error: 'email_taken' });
    const u = db.createUser(b);
    const k = db.issueKey(u.id, 'initial');
    logger.info('user_created', { by: req.auth.user.id, userId: u.id, role: u.role });
    // The ONLY response in the API that contains a raw key: shown once at issuance, never retrievable again.
    res.status(201).json({ user: serializeUser(u), apiKey: { id: k.id, prefix: k.prefix, key: k.raw } });
  });
  users.patch('/:id', admin, (req, res) => {
    const t = db.getUser(req.params.id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const b = z.object({ role: z.enum(['admin', 'member']), disabled: z.boolean() }).partial().strict().parse(req.body);
    const losesAdmin = t.role === 'admin' && !t.disabled && ((b.role === 'member') || b.disabled === true);
    if (losesAdmin && db.countAdmins() <= 1) return res.status(409).json({ error: 'last_admin' }); // never lock everyone out
    if (b.role) db.setUserRole(t.id, b.role);
    if (b.disabled !== undefined) { db.setUserDisabled(t.id, b.disabled); if (b.disabled) db.deleteSessionsForUser(t.id); }
    logger.info('user_updated', { by: req.auth.user.id, userId: t.id });
    res.json({ user: serializeUser(db.getUser(t.id)) });
  });

  // ---- keys: members manage only their own; admins can manage anyone's ----
  const target = (req, res) => {
    const uid = req.query.userId ?? req.body?.userId ?? req.auth.user.id;
    if (uid !== req.auth.user.id && req.auth.user.role !== 'admin') { res.status(403).json({ error: 'forbidden' }); return null; }
    const u = db.getUser(uid);
    if (!u) { res.status(404).json({ error: 'not_found' }); return null; }
    return u;
  };
  keys.get('/', (req, res) => { const u = target(req, res); if (u) res.json({ keys: db.listKeys(u.id).map(serializeKey) }); });
  keys.post('/', (req, res) => {
    const b = z.object({ label: z.string().min(1).max(60), userId: z.string().optional() }).strict().parse(req.body);
    const u = target(req, res); if (!u) return;
    if (u.disabled) return res.status(409).json({ error: 'user_disabled' });
    if (db.listKeys(u.id).filter((k) => !k.revoked_at).length >= MAX_ACTIVE_KEYS) return res.status(409).json({ error: 'too_many_keys' });
    const k = db.issueKey(u.id, b.label);
    logger.info('key_issued', { by: req.auth.user.id, userId: u.id, keyId: k.id });
    res.status(201).json({ apiKey: { id: k.id, prefix: k.prefix, label: b.label, key: k.raw } });
  });
  keys.delete('/:id', (req, res) => {
    const k = db.getKey(req.params.id);
    // members probing someone else's key id get 404 (not 403) so key ids can't be enumerated
    if (!k || (k.user_id !== req.auth.user.id && req.auth.user.role !== 'admin')) return res.status(404).json({ error: 'not_found' });
    db.revokeKey(k.id);
    db.deleteSessionsForKey(k.id); // dashboard sessions created with this key die immediately too
    logger.info('key_revoked', { by: req.auth.user.id, keyId: k.id, userId: k.user_id });
    res.status(204).end();
  });
  return { users, keys };
}
