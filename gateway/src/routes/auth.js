import { Router } from 'express';
import { z } from 'zod';
import { ah, originAllowed } from '../http/middleware.js';
import { sessionCookie, clearCookie } from '../http/cookies.js';
import { serializeUser } from '../http/serializers.js';

export function authRoutes({ db, config, logger, limiter, mw }) {
  const r = Router();
  const body = z.object({ apiKey: z.string().min(1).max(100) });

  // LOGIN: user pastes their personal API key (admin pastes the bootstrap key). Server verifies the hash, then
  // issues a fresh random session token in an HttpOnly cookie. The API key itself is never stored in the browser.
  r.post('/login', ah(async (req, res) => {
    if (!originAllowed(req, config.allowedOrigins)) return res.status(403).json({ error: 'bad_origin' }); // blocks "login CSRF"
    if (limiter.blocked(req.ip)) return res.status(429).json({ error: 'too_many_attempts' });
    const { apiKey } = body.parse(req.body);
    const user = db.authenticate(apiKey);
    if (!user) { limiter.fail(req.ip); logger.warn('login_failed', { ip: req.ip }); return res.status(401).json({ error: 'invalid_credentials' }); } // same reply for unknown/revoked/disabled
    const s = db.createSession({ userId: user.id, keyId: user.keyId, ttlMs: config.sessionTtlMs }); // NEW token every login => no session fixation
    res.setHeader('Set-Cookie', sessionCookie(config, s.token, Math.floor(config.sessionTtlMs / 1000)));
    logger.info('login_ok', { userId: user.id, role: user.role });
    res.json({ user: serializeUser(db.getUser(user.id)), csrfToken: s.csrf, expiresAt: s.expiresAt });
  }));

  // Everything below login needs an identified caller; cookie-authenticated POSTs also need the CSRF token.
  r.use(mw.attach, mw.csrf);

  r.post('/logout', mw.requireAuth, (req, res) => {
    if (req.auth.via === 'session') db.deleteSession(req.auth.token); // server-side invalidation: the cookie value becomes useless
    res.setHeader('Set-Cookie', clearCookie(config));
    res.status(204).end();
  });

  r.get('/me', mw.requireAuth, (req, res) => res.json({ user: serializeUser(db.getUser(req.auth.user.id)), csrfToken: req.auth.csrf ?? null, via: req.auth.via }));
  return r;
}
