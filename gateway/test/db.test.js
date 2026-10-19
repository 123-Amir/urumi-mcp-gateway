import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/database.js';
import { generateApiKey } from '../src/security/apikeys.js';

const fresh = () => openDb(':memory:');

test('issued key authenticates; DB never stores the raw key', () => {
  const db = fresh();
  const u = db.createUser({ email: 'A@x.com', name: 'A', role: 'member' });
  const k = db.issueKey(u.id, 'laptop');
  assert.equal(db.authenticate(k.raw).email, 'a@x.com');
  const dump = JSON.stringify(db.raw.prepare('SELECT * FROM api_keys').all());
  assert.ok(!dump.includes(k.raw), 'raw key must not be in DB');
  assert.ok(!JSON.stringify(db.listKeys(u.id)).includes('key_hash'), 'listKeys must not expose hash');
});
test('revoked key is rejected immediately; other keys unaffected', () => {
  const db = fresh();
  const u = db.createUser({ email: 'b@x.com', name: 'B', role: 'member' });
  const k1 = db.issueKey(u.id, 'one'), k2 = db.issueKey(u.id, 'two');
  assert.ok(db.authenticate(k1.raw));
  assert.equal(db.revokeKey(k1.id), true);
  assert.equal(db.authenticate(k1.raw), null);
  assert.ok(db.authenticate(k2.raw));
  assert.equal(db.revokeKey(k1.id), false); // idempotent
});
test('disabled user cannot authenticate; unknown / malformed keys rejected', () => {
  const db = fresh();
  const u = db.createUser({ email: 'c@x.com', name: 'C', role: 'member' });
  const k = db.issueKey(u.id, 'x');
  db.setUserDisabled(u.id, true);
  assert.equal(db.authenticate(k.raw), null);
  assert.equal(db.authenticate(generateApiKey().raw), null);
  assert.equal(db.authenticate("' OR 1=1 --"), null);
});
test('bootstrap admin seeds once and key works', () => {
  const db = fresh(); const k = generateApiKey();
  assert.equal(db.bootstrapAdmin({ email: 'root@x.com', rawKey: k.raw }), true);
  assert.equal(db.authenticate(k.raw).role, 'admin');
  assert.equal(db.bootstrapAdmin({ email: 'root2@x.com', rawKey: generateApiKey().raw }), false);
  assert.throws(() => fresh().bootstrapAdmin({ email: 'z@x.com', rawKey: 'weak' }));
});
test('server slug rules + unique + CRUD', () => {
  const db = fresh();
  const s = db.createServer({ slug: 'woo', name: 'Woo', url: 'http://woo' });
  assert.throws(() => db.createServer({ slug: 'woo', name: 'dup', url: 'http://x' }));
  for (const bad of ['Woo', 'a__b', '1abc', 'a', 'x'.repeat(40)]) assert.throws(() => db.createServer({ slug: bad, name: 'n', url: 'http://x' }), bad);
  db.updateServer(s.id, { enabled: false });
  assert.equal(db.listEnabledServers().length, 0);
  assert.equal(db.deleteServer(s.id), true);
});
test('audit insert/list, truncates error, limit clamped', () => {
  const db = fresh();
  db.audit({ userId: 'u1', userEmail: 'a@x.com', source: 'mcp', serverSlug: 'woo', tool: 'list_orders', durationMs: 12, success: false, errorSummary: 'x'.repeat(1000) });
  const [r] = db.listAudit();
  assert.equal(r.success, 0); assert.equal(r.error_summary.length, 300);
  assert.equal(db.listAudit({ limit: 99999 }).length, 1);
});
