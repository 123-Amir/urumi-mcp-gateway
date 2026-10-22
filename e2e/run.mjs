#!/usr/bin/env node
// End-to-end run of the assignment's definition-of-done flow against REAL server processes:
//   gateway (src/server.js) + woo-mcp (src/server.js) + demo-mcp utils + demo-mcp notes   <- real code, real HTTP, real MCP SDK client
//   fake WooCommerce (e2e/fake-woocommerce.mjs)                                            <- SIMULATED store
// Chat uses MOCK mode (scripted, no LLM). Nothing here proves real WooCommerce, a real LLM, Kubernetes, or NetworkPolicy behaviour.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { Client } from '../gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { generateApiKey } from '../gateway/src/security/apikeys.js';
import { startFakeWoo } from './fake-woocommerce.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const dbg = (m) => { if (process.env.E2E_DEBUG) console.error(`[dbg ${new Date().toISOString().slice(17, 23)}] ${m}`); };
const procs = []; const results = []; const expected = [];
let scenario = '';

// ------------------------------------------------------------------ tiny test harness
const head = (s) => { scenario = s; console.log(`\n== ${s}`); };
function step(name, ok, evidence = '', status) {
  const st = status ?? (ok ? 'PASS' : 'FAIL'); results.push({ scenario, name, st, evidence });
  console.log(`  ${st.padEnd(9)} ${name}${evidence ? `  [${evidence}]` : ''}`);
}
const textOf = (r) => (r.content ?? []).map((c) => c.text).join('\n');
const json = (r) => JSON.parse(textOf(r));

// ------------------------------------------------------------------ process management (handles kept, so cleanup never pattern-matches)
function start(name, cwd, args, env) {
  const p = spawn('node', args, { cwd: join(ROOT, cwd), env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const rec = { name, p, log: [], cwd, args, env }; procs.push(rec);
  p.stdout.on('data', (d) => rec.log.push(String(d))); p.stderr.on('data', (d) => rec.log.push(String(d)));
  return rec;
}
async function healthy(url, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ } await sleep(150); }
  throw new Error(`${url} never became healthy`);
}
// A process killed by a signal has exitCode === null and signalCode set; checking only exitCode would wait forever for an 'exit' that already fired.
const kill = (rec) => new Promise((res) => { if (rec.p.exitCode !== null || rec.p.signalCode !== null) return res(); rec.p.once('exit', () => res()); rec.p.kill('SIGKILL'); });

// ------------------------------------------------------------------ gateway clients
let GW = '', ORIGIN = '';
async function session(key) {                                  // = what the dashboard does: login, HttpOnly cookie, CSRF header
  const r = await fetch(GW + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ apiKey: key }) });
  const cookie = r.headers.getSetCookie()[0].split(';')[0]; const body = await r.json();
  const call = async (method, path, payload) => { const res = await fetch(GW + path, { method, headers: { cookie, origin: ORIGIN, 'x-csrf-token': body.csrfToken, ...(payload ? { 'content-type': 'application/json' } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    return { status: res.status, json: await res.json().catch(() => null), text: '' }; };
  return { user: body.user, cookie, call };
}
const mcp = async (key) => { const c = new Client({ name: 'e2e-client', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(GW + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${key}` } } })); return c; };
async function tool(who, client, name, args = {}) {            // external-client call, tracked for the audit comparison
  const [server, ...rest] = name.split('__'); expected.push({ email: who.email, source: 'mcp', server, tool: rest.join('__') });
  return client.callTool({ name, arguments: args });
}
async function chat(who, sess, text) {
  const r = await sess.call('POST', '/api/chat', { messages: [{ role: 'user', content: text }] });
  for (const t of r.json?.toolCalls ?? []) expected.push({ email: who.email, source: 'chat', server: t.server, tool: t.tool });
  return r;
}

// ================================================================== run
const tmp = mkdtempSync(join(tmpdir(), 'urumi-e2e-'));
let fatal = null;
try {
  const [woo, wooMcpP, utilsP, notesP, gwP] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  const tok = { woo: randomBytes(20).toString('hex'), utils: randomBytes(20).toString('hex'), notes: randomBytes(20).toString('hex') };
  const wc = { key: 'ck_' + randomBytes(20).toString('hex'), secret: 'cs_' + randomBytes(20).toString('hex') };
  const adminKey = generateApiKey().raw; const encKey = randomBytes(32).toString('base64');
  GW = `http://127.0.0.1:${gwP}`; ORIGIN = GW;

  const fake = await startFakeWoo({ port: woo, key: wc.key, secret: wc.secret });
  start('woo-mcp', 'woo-mcp', ['src/server.js'], { PORT: wooMcpP, WC_BASE_URL: fake.url, WC_CONSUMER_KEY: wc.key, WC_CONSUMER_SECRET: wc.secret, MCP_AUTH_TOKEN: tok.woo, WC_TIMEZONE: 'UTC' });
  start('utils', 'demo-mcp', ['src/server.js'], { PORT: utilsP, MODE: 'utils', MCP_AUTH_TOKEN: tok.utils });
  let notes = start('notes', 'demo-mcp', ['src/server.js'], { PORT: notesP, MODE: 'notes', MCP_AUTH_TOKEN: tok.notes });
  const seeds = [['woo', 'WooCommerce', wooMcpP, tok.woo], ['utils', 'Utilities (demo)', utilsP, tok.utils], ['notes', 'Notes (demo)', notesP, tok.notes]]
    .map(([slug, name, port, credential]) => ({ slug, name, url: `http://127.0.0.1:${port}/mcp`, authType: 'bearer', credential }));
  const gwProc = start('gateway', 'gateway', ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    PORT: gwP, NODE_ENV: 'development', GATEWAY_ENCRYPTION_KEY: encKey, BOOTSTRAP_ADMIN_API_KEY: adminKey, DB_PATH: join(tmp, 'gateway.db'), PUBLIC_ORIGINS: ORIGIN,
    UPSTREAM_ALLOWED_HOSTS: '127.0.0.1', UPSTREAM_REFRESH_MS: '1500', UPSTREAM_CONNECT_TIMEOUT_MS: '2000', UPSTREAM_CALL_TIMEOUT_MS: '5000', UPSTREAM_RETRY_COOLDOWN_MS: '300',
    SEED_SERVERS_JSON: JSON.stringify(seeds), LLM_PROVIDER: 'mock' });
  await Promise.all([healthy(`http://127.0.0.1:${wooMcpP}/healthz`), healthy(`http://127.0.0.1:${utilsP}/healthz`), healthy(`http://127.0.0.1:${notesP}/healthz`), healthy(`${GW}/readyz`)]);
  await sleep(1500);

  // ---------------------------------------------------------------- setup: admin, users A and B
  head('Setup: first admin signs in with the bootstrap key; WooCommerce MCP server is pre-registered');
  const admin = await session(adminKey);
  const list = await admin.call('GET', '/api/servers');
  step('first registered server is the WooCommerce MCP server', list.json.servers[0]?.slug === 'woo', list.json.servers.map((s) => s.slug).join(','));
  step('all three upstreams Connected', list.json.servers.every((s) => s.status === 'connected'), list.json.servers.map((s) => `${s.slug}:${s.status}`).join(' '));
  const mk = async (email) => { const r = await admin.call('POST', '/api/users', { email, name: email.split('@')[0], role: 'member' }); return { ...r.json.user, key: r.json.apiKey.key, keyId: r.json.apiKey.id }; };
  const A = await mk('alice@example.com'), B = await mk('bob@example.com');
  const sa = await session(A.key); const adminMcp = await mcp(adminKey); const adminWho = { email: admin.user.email };
  step('user A and user B exist with individual keys', A.key !== B.key && A.keyId !== B.keyId);

  // ---------------------------------------------------------------- 1
  head('1. Store: shopper checks out; order is visible to the admin  (SIMULATED store: NOT real WooCommerce)');
  const co = await fetch(`${fake.url}/__test/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: 10, quantity: 1 }) });
  const orderId = (await co.json()).order;
  const o1 = json(await tool(adminWho, adminMcp, 'woo__get_order', { id: orderId }));
  step('order placed via the (fake) checkout is readable through the gateway', o1.id === orderId && o1.payment_method === 'Cash on delivery', `order #${o1.number} ${o1.total} ${o1.currency}`, 'SIMULATED');
  step('real storefront + WooCommerce admin UI', false, 'needs the real cluster: not exercised here', 'NOT RUN');

  // ---------------------------------------------------------------- 2
  head('2. As user A: chat agent creates a product; it appears on the storefront');
  const c1 = await chat(A, sa, 'Create a product called Blue Bottle priced 499');
  const created = c1.json.toolCalls[0];
  step('chat called woo__create_product as user A', created?.name === 'woo__create_product' && created.isError === false, `${created?.durationMs} ms`);
  const productId = JSON.parse(created.result).id;
  const shelf = await (await fetch(`${fake.url}/__test/storefront`)).json();
  step('product appears on the (fake) storefront with the right price', shelf.some((p) => p.name === 'Blue Bottle' && p.price === '499'), JSON.stringify(shelf.at(-1)), 'SIMULATED');
  step('reply is labelled as mock mode', c1.json.mock === true && /MOCK MODE/.test(c1.json.reply));

  // ---------------------------------------------------------------- 3
  head('3. A shopper buys it; user A asks the chat agent for today\'s orders');
  await fetch(`${fake.url}/__test/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, quantity: 2 }) });
  const c2 = await chat(A, sa, 'what orders came in today?');
  step('chat used two tools in order: utils__current_date then woo__list_orders', JSON.stringify(c2.json.toolCalls.map((t) => t.name)) === '["utils__current_date","woo__list_orders"]');
  step('answer includes the new order (2 x 499 = 998.00)', /998\.00/.test(c2.json.reply), c2.json.reply.split('\n').at(-1));
  step('customer PII (email/phone) never reaches the chat/tool output', !/shopper@example\.com|9000000000/.test(JSON.stringify(c2.json)));

  // ---------------------------------------------------------------- 4 + 5
  head('4+5. User B connects an external MCP client with ONLY the gateway URL and B\'s key');
  const mcpB = await mcp(B.key);
  const toolsB = (await mcpB.listTools()).tools.map((t) => t.name).sort();
  const want = ['notes__add_note', 'notes__list_notes', 'notes__search_notes', 'utils__calculate', 'utils__current_date', 'woo__create_product', 'woo__get_order', 'woo__list_orders', 'woo__list_products', 'woo__update_order_status'];
  step('B discovers tools from ALL enabled upstreams (10 tools, 3 servers)', JSON.stringify(toolsB) === JSON.stringify(want), `${toolsB.length} tools`);
  const dateB = json(await tool(B, mcpB, 'utils__current_date', {}));
  const ordersB = json(await tool(B, mcpB, 'woo__list_orders', { created_today: true }));
  step('B answers the same "orders today" question (tool level) and sees the order', ordersB.count >= 1 && ordersB.orders.some((o) => o.total === '998.00'), `date ${dateB.date}, ${ordersB.count} order(s)`);
  step('B has no LLM here: the natural-language prompt part is NOT run', false, 'a real client (Claude Code/Cursor) + real LLM needed', 'NOT RUN');

  // ---------------------------------------------------------------- 6
  head('6. One prompt that needs tools from two different upstream servers');
  const servers6 = new Set(c2.json.toolCalls.map((t) => t.server));
  step('the "orders today" prompt touched two upstreams (utils + woo)', servers6.size === 2, [...servers6].join('+'));

  // ---------------------------------------------------------------- 7
  head('7. Revoke user B\'s key: the next request is rejected');
  const rv = await admin.call('DELETE', `/api/keys/${B.keyId}`);
  step('admin revokes B\'s key', rv.status === 204);
  let rejected = false; try { await mcpB.listTools(); } catch (e) { rejected = /401|Unauthorized/i.test(String(e.message)); }
  step('B\'s already-connected client is rejected on its next request', rejected);
  let fresh = false; try { await mcp(B.key); } catch { fresh = true; }
  step('a brand-new connection with B\'s key is rejected too', fresh);
  const bLogin = await fetch(GW + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ apiKey: B.key }) });
  step('B cannot sign in to the dashboard with the revoked key', bLogin.status === 401);

  // ---------------------------------------------------------------- 8
  head('8. Disable an upstream: its tools disappear from the chat agent AND the external client');
  const mcpA = await mcp(A.key);
  const utilsId = list.json.servers.find((s) => s.slug === 'utils').id;
  step('baseline: A (external client + chat tool list) sees utils tools', (await mcpA.listTools()).tools.some((t) => t.name === 'utils__current_date') && (await sa.call('GET', '/api/tools')).json.tools.some((t) => t.name === 'utils__current_date'));
  await admin.call('PATCH', `/api/servers/${utilsId}`, { enabled: false });
  const extAfter = (await mcpA.listTools()).tools.map((t) => t.name); const chatAfter = (await sa.call('GET', '/api/tools')).json.tools.map((t) => t.name);
  step('external client no longer lists utils__* tools', !extAfter.some((n) => n.startsWith('utils__')), `${extAfter.length} tools left`);
  step('chat agent\'s tool list no longer has utils__* tools', !chatAfter.some((n) => n.startsWith('utils__')));
  const c3 = await chat(A, sa, 'what is the date?');
  step('chat can no longer use the date tool (no tool call made, told it is unavailable)', c3.json.toolCalls.length === 0 && /not available/.test(c3.json.reply));
  const direct = await tool(A, mcpA, 'utils__current_date', {});
  step('calling the disabled tool directly is rejected', direct.isError === true);
  await admin.call('PATCH', `/api/servers/${utilsId}`, { enabled: true });
  step('re-enabling brings the tools back', (await mcpA.listTools()).tools.some((t) => t.name === 'utils__current_date'));

  // ---------------------------------------------------------------- 9
  head('9. Kill one upstream process: the others keep working; dashboard shows it unreachable');
  await kill(notes);                                                  // == kubectl delete pod notes (process-level here)
  const dead = await tool(A, mcpA, 'notes__list_notes', {});
  step('call to the dead upstream returns a clear error (no hang)', dead.isError === true && /unreachable/.test(textOf(dead)), textOf(dead).slice(0, 90));
  const alive1 = json(await tool(A, mcpA, 'woo__list_products', {})); const alive2 = json(await tool(A, mcpA, 'utils__calculate', { expression: '6*7' }));
  step('woo and utils still work while notes is down', alive1.length >= 2 && alive2.result === 42);
  const st = (await admin.call('GET', '/api/servers')).json.servers.find((s) => s.slug === 'notes');
  step('dashboard API reports notes as unreachable, with a reason', st.status === 'unreachable' && !!st.statusDetail, st.statusDetail);
  step('notes tools are hidden while it is down', !(await mcpA.listTools()).tools.some((t) => t.name.startsWith('notes__')));
  notes = start('notes', 'demo-mcp', ['src/server.js'], { PORT: notesP, MODE: 'notes', MCP_AUTH_TOKEN: tok.notes });
  await healthy(`http://127.0.0.1:${notesP}/healthz`);
  let back = false; for (let i = 0; i < 20 && !back; i++) { await sleep(500); back = (await admin.call('GET', '/api/servers')).json.servers.find((s) => s.slug === 'notes').status === 'connected'; }
  step('after the process restarts, the gateway reconnects by itself (background refresh)', back);
  step('notes tools work again', (await tool(A, mcpA, 'notes__add_note', { text: 'back online' })).isError !== true);

  // ---------------------------------------------------------------- 11 (security extras)
  head('Extra: security properties asserted on the live system');
  const direct401 = await fetch(`http://127.0.0.1:${wooMcpP}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  step('woo-mcp cannot be used directly without its token (needs the gateway-held credential)', direct401.status === 401);
  step('member A is refused admin APIs (403)', (await sa.call('GET', '/api/servers')).status === 403 && (await sa.call('GET', '/api/users')).status === 403);
  step('SSRF: registering the cloud-metadata address is refused', (await admin.call('POST', '/api/servers', { slug: 'meta', name: 'meta', url: 'http://169.254.169.254/latest', authType: 'none' })).status === 400);
  const serversText = JSON.stringify((await admin.call('GET', '/api/servers')).json);
  step('no upstream credential/token appears in the admin servers API', ![tok.woo, tok.utils, tok.notes].some((t) => serversText.includes(t)));
  await admin.call('POST', '/api/policies', { subjectType: 'role', subject: 'member', serverSlug: 'woo', tool: 'create_product' });
  const hiddenForA = !(await mcpA.listTools()).tools.some((t) => t.name === 'woo__create_product'); const rej = await tool(A, mcpA, 'woo__create_product', { name: 'x', regular_price: '1' });
  const adminStill = (await adminMcp.listTools()).tools.some((t) => t.name === 'woo__create_product');
  step('BONUS tool permissions: member A loses create_product (hidden + rejected); admin keeps it', hiddenForA && rej.isError === true && adminStill);

  // ---------------------------------------------------------------- 10
  head('10. Every tool call is in the audit log under the right user');
  const audit = (await admin.call('GET', '/api/audit?limit=500')).json.entries;
  const key = (e) => `${e.email ?? e.userEmail}|${e.source}|${e.server}|${e.tool}`;
  const got = {}; for (const e of audit) got[key(e)] = (got[key(e)] ?? 0) + 1;
  const exp = {}; for (const e of expected) exp[key(e)] = (exp[key(e)] ?? 0) + 1;
  const missing = Object.entries(exp).filter(([k, n]) => (got[k] ?? 0) !== n).map(([k, n]) => `${k} expected ${n} got ${got[k] ?? 0}`);
  const extra = Object.keys(got).filter((k) => !(k in exp));
  step(`all ${expected.length} calls made in this run appear in the audit log, per user + source + server + tool`, missing.length === 0 && extra.length === 0, missing.concat(extra).slice(0, 3).join('; ') || `${audit.length} rows`);
  const byUser = (email) => audit.filter((e) => e.userEmail === email).length;
  step('rows are attributed to the right users', byUser('bob@example.com') === 2 && byUser('alice@example.com') > 5, `bob=${byUser('bob@example.com')} alice=${byUser('alice@example.com')} admin=${byUser('admin@example.com')}`);
  step('failed calls recorded as failures with a safe summary', audit.some((e) => !e.success && /unreachable/.test(e.errorSummary ?? '')) && audit.some((e) => !e.success && e.errorSummary === 'forbidden'));
  step('rows carry duration + timestamp; no arguments or secrets are stored', audit.every((e) => Number.isInteger(e.durationMs) && e.timestamp) && !JSON.stringify(audit).includes('Blue Bottle') && ![tok.woo, adminKey, A.key, B.key].some((s) => JSON.stringify(audit).includes(s)));
  const gwLog = gwProc.log.join('');
  step('gateway process logs contain no API keys or upstream tokens', ![adminKey, A.key, B.key, tok.woo, tok.utils, tok.notes, wc.secret, encKey].some((s) => gwLog.includes(s)));
  console.log('\n  audit log (newest first, first 12 rows):');
  for (const e of audit.slice(0, 12)) console.log(`    ${e.timestamp}  ${String(e.userEmail).padEnd(18)} ${e.source.padEnd(4)} ${(e.server + '.' + e.tool).padEnd(28)} ${String(e.durationMs).padStart(4)}ms ${e.success ? 'ok ' : 'FAIL'} ${e.errorSummary ?? ''}`.slice(0, 150));
  dbg('closing clients'); await Promise.allSettled([adminMcp.close(), mcpA.close()]); dbg('clients closed'); fake.close(); dbg('fake closed');
} catch (e) { fatal = e; console.error('\nFATAL:', e); for (const r of procs) console.error(`--- ${r.name} log tail ---\n${r.log.join('').slice(-600)}`); }
finally { dbg('killing procs'); for (const r of procs) { await kill(r); dbg(`killed ${r.name}`); } rmSync(tmp, { recursive: true, force: true }); }

// ------------------------------------------------------------------ report
const count = (s) => results.filter((r) => r.st === s).length;
console.log(`\nRESULT: ${count('PASS')} PASS, ${count('SIMULATED')} SIMULATED (against fake WooCommerce), ${count('NOT RUN')} NOT RUN, ${count('FAIL')} FAIL${fatal ? ', FATAL ERROR' : ''}`);
const md = ['# Last end-to-end run (`node e2e/run.mjs`)', '', `Run at ${new Date().toISOString()}. Real gateway/woo-mcp/demo-mcp processes + official MCP SDK client; **WooCommerce is a fake** and chat is **mock mode** (no LLM).`, '',
  `**${count('PASS')} PASS, ${count('SIMULATED')} SIMULATED, ${count('NOT RUN')} NOT RUN, ${count('FAIL')} FAIL**`, '', '| Scenario | Check | Status | Evidence |', '|---|---|---|---|',
  ...results.map((r) => `| ${r.scenario.replace(/\|/g, '/')} | ${r.name.replace(/\|/g, '/')} | ${r.st} | ${String(r.evidence).replace(/\|/g, '/').replace(/\n/g, ' ')} |`)].join('\n');
writeFileSync(join(ROOT, 'docs', 'E2E_LAST_RUN.md'), md + '\n');
process.exit(fatal || count('FAIL') ? 1 : 0);
