import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGateway, api, login, ORIGIN } from './helpers.js';

let gw, call;
before(async () => { gw = await startGateway(); call = api(gw.base); });
after(() => gw.close());

const newMember = async (email = `m${Math.random().toString(36).slice(2, 8)}@x.com`) => {
  const adm = await login(call, gw.adminKey);
  const r = await call('POST', '/api/users', { body: { email, name: 'M', role: 'member' }, cookie: adm.cookie, csrf: adm.csrf, origin: ORIGIN });
  assert.equal(r.status, 201);
  return { id: r.json.user.id, key: r.json.apiKey.key, keyId: r.json.apiKey.id };
};

test('login with bootstrap admin key: sets HttpOnly SameSite cookie; body has no key/hash; key not in logs', async () => {
  const r = await login(call, gw.adminKey);
  assert.equal(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Strict/); assert.match(r.setCookie, /Path=\//); assert.match(r.setCookie, /Max-Age=\d+/);
  assert.ok(!/Secure/.test(r.setCookie), 'dev config: not Secure');
  assert.equal(r.json.user.role, 'admin');
  assert.ok(!r.text.includes(gw.adminKey) && !/hash/i.test(r.text));
  assert.ok(!gw.logs.join('\n').includes(gw.adminKey), 'raw API key must never appear in logs');
  assert.ok(!gw.logs.join('\n').includes(r.cookie.split('=')[1]), 'session token must never appear in logs');
});

test('production-style config: cookie is Secure and __Host- prefixed', async () => {
  const g = await startGateway({ cookie: { secure: true, sameSite: 'Strict', name: '__Host-umk_session' } });
  try { const r = await login(api(g.base), g.adminKey); assert.match(r.setCookie, /^__Host-umk_session=/); assert.match(r.setCookie, /; Secure/); }
  finally { await g.close(); }
});

test('member logs in with OWN key and is a member', async () => {
  const m = await newMember(); const r = await login(call, m.key);
  assert.equal(r.status, 200); assert.equal(r.json.user.role, 'member');
});

test('wrong / malformed / unknown keys: 401 with identical generic body', async () => {
  const bodies = [];
  for (const k of ['umk_aaaaaaaa_' + 'b'.repeat(43), 'garbage', '']) { const r = await call('POST', '/api/auth/login', { body: { apiKey: k } }); assert.ok([401, 400].includes(r.status)); if (r.status === 401) bodies.push(r.text); }
  assert.ok(bodies.length >= 2 && bodies.every((b) => b === bodies[0]));
});

test('unauthenticated requests to protected endpoints => 401', async () => {
  for (const [m, p] of [['GET', '/api/auth/me'], ['GET', '/api/servers'], ['GET', '/api/users'], ['GET', '/api/keys'], ['GET', '/api/audit'], ['GET', '/api/tools'], ['GET', '/api/policies'], ['POST', '/api/auth/logout']])
    assert.equal((await call(m, p)).status, 401, `${m} ${p}`);
  assert.equal((await call('GET', '/api/auth/me', { key: 'umk_aaaaaaaa_' + 'b'.repeat(43) })).status, 401);
  assert.equal((await call('GET', '/api/auth/me', { cookie: 'umk_session=forgedtokenforgedtokenforgedtoken' })).status, 401);
});

test('role restrictions: member gets 403 on every admin endpoint (cookie AND bearer)', async () => {
  const m = await newMember(); const s = await login(call, m.key);
  const adminOnly = [['GET', '/api/servers'], ['POST', '/api/servers', { slug: 'x1', name: 'x', url: 'http://127.0.0.1:1/mcp' }], ['PATCH', '/api/servers/abc', { enabled: false }], ['DELETE', '/api/servers/abc'],
    ['GET', '/api/users'], ['POST', '/api/users', { email: 'e@x.com', name: 'e' }], ['PATCH', `/api/users/${m.id}`, { role: 'admin' }], ['GET', '/api/policies'], ['POST', '/api/policies', { subjectType: 'role', subject: 'member', serverSlug: 'woo', tool: '*' }]];
  for (const [method, path, body] of adminOnly) {
    assert.equal((await call(method, path, { body, cookie: s.cookie, csrf: s.csrf, origin: ORIGIN })).status, 403, `cookie ${method} ${path}`);
    assert.equal((await call(method, path, { body, key: m.key })).status, 403, `bearer ${method} ${path}`);
  }
  // privilege escalation attempt: member promotes self
  assert.equal((await call('PATCH', `/api/users/${m.id}`, { body: { role: 'admin' }, key: m.key })).status, 403);
  assert.equal((await call('GET', '/api/auth/me', { key: m.key })).json.user.role, 'member');
});

test('member can only see/manage own keys; others\' key ids look nonexistent; audit is scoped', async () => {
  const a = await newMember(), b = await newMember(); const sa = await login(call, a.key);
  assert.equal((await call('GET', `/api/keys?userId=${b.id}`, { cookie: sa.cookie })).status, 403);
  assert.equal((await call('POST', '/api/keys', { body: { label: 'x', userId: b.id }, cookie: sa.cookie, csrf: sa.csrf })).status, 403);
  assert.equal((await call('DELETE', `/api/keys/${b.keyId}`, { cookie: sa.cookie, csrf: sa.csrf })).status, 404);
  assert.equal((await call('GET', `/api/audit?userId=${b.id}`, { cookie: sa.cookie })).status, 403);
  // b's key still works
  assert.equal((await call('GET', '/api/auth/me', { key: b.key })).status, 200);
  const mine = await call('GET', '/api/keys', { cookie: sa.cookie });
  assert.equal(mine.json.keys.length, 1); assert.ok(!/hash/i.test(mine.text) && !mine.text.includes(a.key));
});

test('CSRF: cookie-authenticated POST without token / wrong token / foreign Origin => 403; correct => ok', async () => {
  const s = await login(call, gw.adminKey);
  const post = (extra) => call('POST', '/api/keys', { body: { label: 'csrf' }, cookie: s.cookie, ...extra });
  assert.equal((await post({ origin: ORIGIN })).status, 403, 'missing token');
  assert.equal((await post({ origin: ORIGIN, csrf: 'wrong' + s.csrf })).status, 403, 'wrong token');
  assert.equal((await post({ origin: 'http://evil.example', csrf: s.csrf })).status, 403, 'foreign origin even with valid token');
  assert.equal((await post({ origin: ORIGIN, csrf: s.csrf })).status, 201, 'valid');
  // login CSRF: foreign Origin cannot start a session
  assert.equal((await call('POST', '/api/auth/login', { body: { apiKey: gw.adminKey }, origin: 'http://evil.example' })).status, 403);
});

test('bearer-key requests need no CSRF token (not an ambient credential)', async () => {
  assert.equal((await call('POST', '/api/keys', { body: { label: 'cli' }, key: gw.adminKey })).status, 201);
});

test('logout invalidates the session SERVER-side (old cookie dies, even if replayed)', async () => {
  const s = await login(call, gw.adminKey);
  assert.equal((await call('GET', '/api/auth/me', { cookie: s.cookie })).status, 200);
  const out = await call('POST', '/api/auth/logout', { cookie: s.cookie, csrf: s.csrf, origin: ORIGIN });
  assert.equal(out.status, 204); assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await call('GET', '/api/auth/me', { cookie: s.cookie })).status, 401, 'replayed cookie must be dead');
});

test('session expiry: absolute TTL and idle timeout (clock fast-forwarded)', async () => {
  const s1 = await login(call, gw.adminKey);
  gw.clock.t += gw.config.sessionIdleMs + 1000;
  assert.equal((await call('GET', '/api/auth/me', { cookie: s1.cookie })).status, 401, 'idle timeout');
  const s2 = await login(call, gw.adminKey);
  for (let i = 0; i < 6; i++) { gw.clock.t += 9 * 60_000; assert.equal((await call('GET', '/api/auth/me', { cookie: s2.cookie })).status, 200, 'activity keeps it alive'); }
  gw.clock.t += 9 * 60_000; // total > 60 min absolute TTL
  assert.equal((await call('GET', '/api/auth/me', { cookie: s2.cookie })).status, 401, 'absolute expiry despite activity');
  assert.equal(gw.db.countSessions() >= 0, true);
});

test('revoking a key kills its live dashboard session and API access IMMEDIATELY', async () => {
  const m = await newMember(); const s = await login(call, m.key);
  assert.equal((await call('GET', '/api/auth/me', { cookie: s.cookie })).status, 200);
  const adm = await login(call, gw.adminKey);
  assert.equal((await call('DELETE', `/api/keys/${m.keyId}`, { cookie: adm.cookie, csrf: adm.csrf, origin: ORIGIN })).status, 204);
  assert.equal((await call('GET', '/api/auth/me', { cookie: s.cookie })).status, 401, 'session dead');
  assert.equal((await call('GET', '/api/auth/me', { key: m.key })).status, 401, 'bearer dead');
  assert.equal((await login(call, m.key)).status, 401, 'cannot log in again');
});

test('disabling a user kills sessions; last admin cannot be demoted/disabled', async () => {
  const m = await newMember(); const s = await login(call, m.key); const adm = await login(call, gw.adminKey);
  await call('PATCH', `/api/users/${m.id}`, { body: { disabled: true }, cookie: adm.cookie, csrf: adm.csrf, origin: ORIGIN });
  assert.equal((await call('GET', '/api/auth/me', { cookie: s.cookie })).status, 401);
  assert.equal((await login(call, m.key)).status, 401);
  const me = (await call('GET', '/api/auth/me', { cookie: adm.cookie })).json.user;
  for (const body of [{ role: 'member' }, { disabled: true }])
    assert.equal((await call('PATCH', `/api/users/${me.id}`, { body, cookie: adm.cookie, csrf: adm.csrf, origin: ORIGIN })).status, 409);
});

test('API responses never contain key hashes, upstream credentials or encrypted blobs', async () => {
  const adm = await login(call, gw.adminKey);
  const r = await call('POST', '/api/servers', { body: { slug: 'leaky', name: 'L', url: 'http://127.0.0.1:1/mcp', authType: 'bearer', credential: 'SUPER-SECRET-TOKEN-123' }, cookie: adm.cookie, csrf: adm.csrf, origin: ORIGIN });
  assert.equal(r.status, 201); assert.equal(r.json.server.hasCredential, true);
  const everything = [r.text, (await call('GET', '/api/servers', { cookie: adm.cookie })).text, (await call('GET', '/api/users', { cookie: adm.cookie })).text, (await call('GET', '/api/keys', { cookie: adm.cookie })).text, (await call('GET', '/api/audit', { cookie: adm.cookie })).text].join('\n');
  for (const needle of ['SUPER-SECRET', 'credential_enc', 'key_hash', 'v1.']) assert.ok(!everything.includes(needle), `leaked ${needle}`);
  assert.ok(!gw.logs.join('\n').includes('SUPER-SECRET'));
  const raw = JSON.stringify(gw.db.raw.prepare('SELECT credential_enc FROM servers').all()); assert.ok(!raw.includes('SUPER-SECRET'), 'encrypted at rest');
});

test('login rate limit: repeated failures => 429', async () => {
  const g = await startGateway(); const c = api(g.base);
  try {
    let last; for (let i = 0; i < 7; i++) last = await c('POST', '/api/auth/login', { body: { apiKey: 'umk_aaaaaaaa_' + 'b'.repeat(43) } });
    assert.equal(last.status, 429);
    assert.equal((await c('POST', '/api/auth/login', { body: { apiKey: g.adminKey } })).status, 429, 'even a correct key is throttled while blocked');
  } finally { await g.close(); }
});

test('oversized / invalid JSON bodies are rejected cleanly', async () => {
  const adm = await login(call, gw.adminKey);
  assert.equal((await call('POST', '/api/keys', { body: { label: 'x'.repeat(100_000) }, cookie: adm.cookie, csrf: adm.csrf })).status, 413);
  const res = await fetch(gw.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
});
