import { extractKey } from '../security/apikeys.js';
import { parseCookies, clearCookie } from './cookies.js';
import { timingSafeEqual } from 'node:crypto';
import { UrlRejected } from '../security/ssrf.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// Origin rule: if the browser sent an Origin it MUST be one of ours. Browsers always attach Origin to cross-site
// POST/PATCH/DELETE, so a forged form on evil.com is rejected here. Missing Origin = non-browser client (curl, tests);
// those cannot be CSRF'd because they have no ambient cookie, and session requests still need the CSRF token below.
export function originAllowed(req, allowed) {
  const o = req.headers.origin;
  return o === undefined ? true : allowed.includes(o);
}

export function makeAuth({ db, config }) {
  // Resolve who is calling. Explicit API key (Bearer / x-api-key) wins over cookie.
  const attach = (req, res, next) => {
    const key = extractKey(req.headers);
    if (key !== null) {
      const user = db.authenticate(key); // hash lookup; revoked/disabled => null
      if (!user) return res.status(401).json({ error: 'unauthenticated' });
      req.auth = { user, via: 'key' };
      return next();
    }
    const token = parseCookies(req.headers.cookie)[config.cookie.name];
    if (token) {
      const s = db.getSession(token, config.sessionIdleMs); // expiry, idle, key-revoked, user-disabled all checked here
      if (!s) { res.setHeader('Set-Cookie', clearCookie(config)); return res.status(401).json({ error: 'unauthenticated' }); }
      req.auth = { user: s.user, via: 'session', csrf: s.csrf, token };
    }
    next();
  };
  // CSRF only matters for requests authenticated by a cookie (ambient credential). Bearer keys are not ambient.
  const csrf = (req, res, next) => {
    if (SAFE.has(req.method) || req.auth?.via !== 'session') return next();
    if (!originAllowed(req, config.allowedOrigins)) return res.status(403).json({ error: 'bad_origin' });
    const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    const want = Buffer.from(req.auth.csrf);
    if (sent.length !== want.length || !timingSafeEqual(sent, want)) return res.status(403).json({ error: 'csrf_failed' });
    next();
  };
  const requireAuth = (req, res, next) => (req.auth ? next() : res.status(401).json({ error: 'unauthenticated' }));
  const requireRole = (role) => (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'unauthenticated' });
    // role comes from the DB on every request (not from the cookie), so it cannot be forged or go stale
    return req.auth.user.role === role ? next() : res.status(403).json({ error: 'forbidden' });
  };
  return { attach, csrf, requireAuth, requireRole };
}

// Failed-login limiter (per IP). In-memory: fine for one replica; for many replicas move to shared store.
export function makeLoginLimiter({ max, windowMs }) {
  const hits = new Map();
  const bucket = (ip) => { const n = Date.now(); let b = hits.get(ip); if (!b || b.reset <= n) { b = { n: 0, reset: n + windowMs }; hits.set(ip, b); } return b; };
  return {
    blocked: (ip) => bucket(ip).n >= max,
    fail: (ip) => { bucket(ip).n++; if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= Date.now()) hits.delete(k); },
  };
}

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store'); // API responses can contain one-time keys; never cache
  next();
}

export function errorHandler(logger) {
  return (err, req, res, _next) => {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'validation_failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err?.status === 400 || err instanceof UrlRejected) return res.status(400).json({ error: 'bad_request', message: err.message });
    logger.error('unhandled_error', { path: req.path, error: err?.message });
    res.status(500).json({ error: 'internal_error' }); // never leak stack/internal text to clients
  };
}
