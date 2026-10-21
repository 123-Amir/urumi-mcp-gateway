// CONTRACT: the dashboard's REAL api.js talking to the REAL gateway (no mocks on either side). api.js is plain ESM, so we import it
// directly and give it a fetch that behaves like a browser for our purposes: base URL, an Origin header, and a cookie jar that only
// ever contains the HttpOnly session cookie (api.js itself can never read it, just like page JS).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startGateway, startUpstream, textTool, ORIGIN } from './helpers.js';
import { api, setUnauthorizedHandler, ApiError } from '../../dashboard/src/api.js';

let gw, up; let jar = ''; let unauth = 0;
const realFetch = globalThis.fetch;
before(async () => {
  gw = await startGateway();
  up = await startUpstream({ name: 'utils', tools: { current_date: textTool(() => JSON.stringify({ date: '2026-10-20', time: '10:00:00', timezone: 'UTC' })) } });
  globalThis.fetch = async (path, init = {}) => {
    // Gateway and dashboard client share this process, so only rewrite the dashboard's RELATIVE urls; the gateway's own absolute upstream calls pass through untouched.
    if (!String(path).startsWith('/')) return realFetch(path, init);
    const res = await realFetch(gw.base + path, { ...init, headers: { ...init.headers, origin: ORIGIN, ...(jar ? { cookie: jar } : {}) } });
    const sc = res.headers.getSetCookie?.()[0]; if (sc) jar = sc.startsWith('umk_session=;') || /Max-Age=0/.test(sc) ? '' : sc.split(';')[0];
    return res;
  };
  setUnauthorizedHandler(() => { unauth++; });
});
after(async () => { globalThis.fetch = realFetch; await gw.close(); await up.close(); });

test('admin journey through the real UI client: login, CSRF-protected writes, servers, keys, members', async () => {
  const me = await api.login(gw.adminKey);
  assert.equal(me.role, 'admin'); assert.ok(jar.startsWith('umk_session='), 'session cookie set by server');
  assert.deepEqual((await api.me()).email, 'admin@x.com');

  const s = await api.createServer({ slug: 'utils', name: 'Utilities', url: up.url, enabled: true, authType: 'none' });
  assert.equal(s.status, 'connected', 'create: ' + JSON.stringify(s.statusDetail)); assert.deepEqual(s.tools.map((t) => t.namespacedName), ['utils__current_date']); assert.equal(s.hasCredential, false);
  assert.ok(!JSON.stringify(await api.servers()).match(/credential_enc|key_hash/));

  const created = await api.createUser({ email: 'bob@x.com', name: 'Bob', role: 'member' });
  assert.match(created.apiKey.key, /^umk_/); const bobKey = created.apiKey.key; const bobId = created.user.id;
  assert.equal((await api.users()).length, 2);
  const k2 = await api.createKey('ci', bobId); assert.equal((await api.keys(bobId)).length, 2);
  await api.revokeKey(k2.id); assert.ok((await api.keys(bobId)).find((k) => k.id === k2.id).revokedAt);
  assert.equal((await api.updateUser(bobId, { disabled: true })).disabled, true); await api.updateUser(bobId, { disabled: false });

  const off = await api.updateServer(s.id, { enabled: false }); assert.equal(off.status, 'disabled'); assert.deepEqual(off.tools, []);
  const on = await api.updateServer(s.id, { enabled: true }); assert.equal(on.status, 'connected', 're-enable: ' + JSON.stringify(on.statusDetail));
  const rf = await api.refreshServer(s.id); assert.equal(rf.status, 'connected', 'refresh: ' + JSON.stringify(rf.statusDetail));

  const info = await api.chatInfo(); assert.equal(info.mock, true);
  const r = await api.chat([{ role: 'user', content: 'what is the date?' }]);
  assert.equal(r.toolCalls[0].name, 'utils__current_date'); assert.match(r.reply, /MOCK MODE/);
  const entries = await api.audit({ limit: 10 }); assert.ok(entries.some((e) => e.source === 'chat' && e.server === 'utils' && e.userEmail === 'admin@x.com' && e.success));

  await api.logout();
  await assert.rejects(api.me(), (e) => e instanceof ApiError && e.status === 401);
  gw.bobKey = bobKey; gw.bobId = bobId;
});

test('without the CSRF token, a cookie-authenticated write is refused by the real server (UI client forgets it on logout)', async () => {
  await api.login(gw.adminKey);
  const cookieOnly = await realFetch(gw.base + '/api/keys', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: jar }, body: JSON.stringify({ label: 'x' }) });
  assert.equal(cookieOnly.status, 403);
  await api.logout();
});

test('member journey: sees tools, is refused admin APIs (403) by the server, own audit only; revoked key => next UI call 401 + sign-out handler fired', async () => {
  const me = await api.login(gw.bobKey); assert.equal(me.role, 'member');
  assert.deepEqual((await api.tools()).map((t) => t.name), ['utils__current_date']);
  for (const call of [() => api.servers(), () => api.users(), () => api.createServer({ slug: 'x1', name: 'x', url: up.url })])
    await assert.rejects(call(), (e) => e instanceof ApiError && e.status === 403);
  const r = await api.chat([{ role: 'user', content: 'what is the date?' }]); assert.equal(r.toolCalls.length, 1);
  assert.ok((await api.audit()).every((e) => e.userEmail === 'bob@x.com'));
  const own = await api.keys(); assert.ok(own.length >= 1);
  // admin revokes Bob's key out-of-band
  const adminKeyId = gw.db.listKeys(gw.bobId).filter((k) => !k.revoked_at).map((k) => k.id);
  for (const id of adminKeyId) gw.db.revokeKey(id), gw.db.deleteSessionsForKey(id);
  const before = unauth;
  await assert.rejects(api.tools(), (e) => e.status === 401);
  assert.equal(unauth, before + 1, 'UI client signalled sign-out');
});
