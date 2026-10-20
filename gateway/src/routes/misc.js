import { Router } from 'express';
import { z } from 'zod';
import { serializeAudit } from '../http/serializers.js';

export function miscRoutes({ db, service, mw }) {
  const r = Router();
  // Tools THIS user may see (same filtered list an external MCP client gets).
  r.get('/tools', (req, res) => res.json({ tools: service.listTools(req.auth.user) }));

  // Audit: admin sees everyone (optional userId filter); member sees ONLY their own rows (forced server-side).
  r.get('/audit', (req, res) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0), userId: z.string().optional() }).parse(req.query);
    const me = req.auth.user;
    if (me.role !== 'admin' && q.userId && q.userId !== me.id) return res.status(403).json({ error: 'forbidden' });
    const userId = me.role === 'admin' ? q.userId : me.id;
    res.json({ entries: db.listAudit({ userId, limit: q.limit, offset: q.offset }).map(serializeAudit) });
  });

  // Tool deny-rules (admin only).
  const admin = mw.requireRole('admin');
  r.get('/policies', admin, (req, res) => res.json({ rules: db.listToolRules() }));
  r.post('/policies', admin, (req, res) => {
    const b = z.object({ subjectType: z.enum(['role', 'user']), subject: z.string().min(1).max(80), serverSlug: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/), tool: z.string().regex(/^(\*|[A-Za-z0-9_-]{1,32})$/) }).strict().parse(req.body);
    if (b.subjectType === 'role' && b.subject !== 'member') return res.status(400).json({ error: 'bad_request', message: 'rules apply to role "member" only (admins are never restricted)' });
    if (b.subjectType === 'user' && !db.getUser(b.subject)) return res.status(404).json({ error: 'not_found' });
    try { db.addToolRule(b); } catch (e) { if (!/UNIQUE/.test(e.message)) throw e; }
    res.status(201).json({ rules: db.listToolRules() });
  });
  r.delete('/policies/:id', admin, (req, res) => (db.deleteToolRule(Number(req.params.id)) ? res.status(204).end() : res.status(404).json({ error: 'not_found' })));
  return r;
}
