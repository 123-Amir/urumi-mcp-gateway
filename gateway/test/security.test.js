import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateApiKey, hashApiKey, looksLikeApiKey, extractKey } from '../src/security/apikeys.js';
import { encrypt, decrypt, parseMasterKey } from '../src/security/secretbox.js';
import { assertSafeUpstreamUrl, classifyIp, UrlRejected } from '../src/security/ssrf.js';

test('api key: format, uniqueness, hash is not the raw key', () => {
  const a = generateApiKey(), b = generateApiKey();
  assert.ok(looksLikeApiKey(a.raw));
  assert.notEqual(a.raw, b.raw);
  assert.notEqual(a.hash, a.raw);
  assert.equal(a.hash, hashApiKey(a.raw));
  assert.equal(a.hash.length, 64);
});
test('api key: rejects malformed input', () => {
  for (const bad of ['', 'abc', 'umk_short', null, undefined, 'x'.repeat(500), "umk_';DROP TABLE--_" + 'a'.repeat(43)])
    assert.equal(looksLikeApiKey(bad), false);
});
test('extractKey: bearer and x-api-key', () => {
  assert.equal(extractKey({ authorization: 'Bearer abc' }), 'abc');
  assert.equal(extractKey({ 'x-api-key': 'k' }), 'k');
  assert.equal(extractKey({ authorization: 'Basic abc' }), null);
});

const key = parseMasterKey(randomBytes(32).toString('base64'));
test('secretbox: roundtrip, random iv, tamper + wrong key detected', () => {
  const c1 = encrypt('s3cret-token', key), c2 = encrypt('s3cret-token', key);
  assert.notEqual(c1, c2);
  assert.ok(!c1.includes('s3cret'));
  assert.equal(decrypt(c1, key), 's3cret-token');
  const parts = c1.split('.'); parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decrypt(parts.join('.'), key));
  assert.throws(() => decrypt(c1, parseMasterKey(randomBytes(32).toString('base64'))));
  assert.throws(() => parseMasterKey('short'));
});

test('ssrf: classifyIp', () => {
  const cases = { '169.254.169.254': 'blocked', '10.1.2.3': 'private', '127.0.0.1': 'private', '172.20.0.1': 'private',
    '172.32.0.1': 'public', '8.8.8.8': 'public', '0.0.0.0': 'blocked', '::1': 'private', 'fe80::1': 'blocked',
    'fd00:ec2::254': 'blocked', 'fc00::1': 'private', '::ffff:169.254.169.254': 'blocked', '::ffff:a9fe:a9fe': 'blocked',
    '::ffff:10.0.0.1': 'private', '2606:4700::1111': 'public' };
  for (const [ip, want] of Object.entries(cases)) assert.equal(classifyIp(ip), want, ip);
});
const res = (map) => async (h) => (map[h] ?? []).map((address) => ({ address }));
test('ssrf: blocks metadata even if allowlisted / allowPrivate', async () => {
  for (const u of ['http://169.254.169.254/latest/meta-data', 'http://[fd00:ec2::254]/', 'http://metadata.google.internal/'])
    await assert.rejects(assertSafeUpstreamUrl(u, { allowPrivate: true, allowlist: ['169.254.169.254', 'metadata.google.internal'] }), UrlRejected);
});
test('ssrf: DNS name resolving to metadata IP is blocked (any answer)', async () => {
  const resolver = res({ 'evil.example.com': ['93.184.216.34', '169.254.169.254'] });
  await assert.rejects(assertSafeUpstreamUrl('https://evil.example.com/mcp', { resolver }), /blocked/);
});
test('ssrf: private blocked by default, allowed via allowlist suffix/exact or dev flag', async () => {
  const resolver = res({ 'woo-mcp.urumi.svc.cluster.local': ['10.43.1.5'], 'other.internal': ['10.43.1.6'] });
  await assert.rejects(assertSafeUpstreamUrl('http://woo-mcp.urumi.svc.cluster.local/mcp', { resolver }), /allowlist/);
  await assertSafeUpstreamUrl('http://woo-mcp.urumi.svc.cluster.local/mcp', { resolver, allowlist: ['.svc.cluster.local'] });
  await assert.rejects(assertSafeUpstreamUrl('http://other.internal/mcp', { resolver, allowlist: ['.svc.cluster.local'] }), /allowlist/);
  await assertSafeUpstreamUrl('http://other.internal/mcp', { resolver, allowPrivate: true });
  await assertSafeUpstreamUrl('http://127.0.0.1:9000/mcp', { allowPrivate: true });
});
test('ssrf: scheme, userinfo, bad url, unresolvable', async () => {
  const resolver = res({});
  for (const u of ['file:///etc/passwd', 'gopher://x', 'http://user:pw@example.com', 'not a url', 'http://nohost.example'])
    await assert.rejects(assertSafeUpstreamUrl(u, { resolver }), UrlRejected, u);
});
test('ssrf: public host passes', async () => {
  await assertSafeUpstreamUrl('https://mcp.example.com/mcp', { resolver: res({ 'mcp.example.com': ['93.184.216.34'] }) });
});
