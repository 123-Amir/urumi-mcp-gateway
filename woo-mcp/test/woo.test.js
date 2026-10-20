import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { startOfToday, shapeOrder } from '../src/tools.js';

// ---- FAKE WooCommerce REST API (v3). Shapes copied from WooCommerce docs, including PII fields we must NOT leak. ----
const wcLog = []; let delayMs = 0, forceStatus = 0;
const PRODUCTS = [{ id: 11, name: 'Mug', status: 'publish', price: '9.00', regular_price: '9.00', stock_status: 'instock', sku: '', permalink: 'http://shop.local/product/mug/' }];
const ORDER = { id: 101, number: '101', status: 'processing', total: '18.00', currency: 'INR', date_created: '2026-10-20T10:00:00', payment_method: 'cod', payment_method_title: 'Cash on delivery', customer_id: 0,
  billing: { first_name: 'Asha', last_name: 'Rao', email: 'asha@example.com', phone: '9999999999', address_1: '12 MG Road' }, shipping: { address_1: '12 MG Road' },
  line_items: [{ product_id: 11, name: 'Mug', quantity: 2, total: '18.00', sku: 'x' }] };
let wcServer, wcBase, woo, mcpBase;
const TOKEN = 'mcp-internal-token', KEY = 'ck_test', SECRET = 'cs_test';

before(async () => {
  const wc = express(); wc.use(express.json());
  wc.use('/wp-json/wc/v3', async (req, res) => {
    wcLog.push({ method: req.method, path: req.path, query: req.query, body: req.body, auth: req.headers.authorization, xfp: req.headers['x-forwarded-proto'] });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (forceStatus) return res.status(forceStatus).json({ code: 'x', message: forceStatus === 401 ? 'Sorry, you cannot list resources.' : 'boom <b>html</b>' });
    if (req.headers.authorization !== 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64')) return res.status(401).json({ message: 'bad auth' });
    if (req.method === 'GET' && req.path === '/products') return res.json(PRODUCTS);
    if (req.method === 'POST' && req.path === '/products') return res.status(201).json({ id: 12, status: req.body.status, name: req.body.name, price: req.body.regular_price, regular_price: req.body.regular_price, stock_status: 'instock', permalink: 'http://shop.local/product/new/' });
    if (req.method === 'GET' && req.path === '/orders') return res.json([ORDER]);
    if (req.method === 'GET' && req.path === '/orders/101') return res.json(ORDER);
    if (req.method === 'PUT' && req.path === '/orders/101') return res.json({ ...ORDER, status: req.body.status });
    if (req.path.startsWith('/orders/')) return res.status(404).json({ code: 'woocommerce_rest_shop_order_invalid_id', message: 'Invalid ID.' });
    res.status(404).json({ message: 'no route' });
  });
  wcServer = http.createServer(wc); await new Promise((r) => wcServer.listen(0, '127.0.0.1', r)); wcBase = `http://127.0.0.1:${wcServer.address().port}`;
  const cfg = { wcBaseUrl: wcBase, wcKey: KEY, wcSecret: SECRET, mcpToken: TOKEN, wcTimeoutMs: 300, wcForwardHttps: true, timezone: 'Asia/Kolkata' };
  woo = http.createServer(createApp(cfg, { now: () => new Date('2026-10-19T20:00:00Z'), log: () => {} })); // 20:00Z = 01:30 on 20 Oct in IST
  await new Promise((r) => woo.listen(0, '127.0.0.1', r)); mcpBase = `http://127.0.0.1:${woo.address().port}`;
});
after(() => { wcServer.closeAllConnections(); woo.closeAllConnections(); wcServer.close(); woo.close(); });
const client = async (token = TOKEN) => { const c = new Client({ name: 't', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(mcpBase + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })); return c; };
const data = (r) => JSON.parse(r.content[0].text);
const last = () => wcLog[wcLog.length - 1];

test('exposes exactly the 5 required tools, with accurate read-only / destructive annotations', async () => {
  const c = await client(); const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['create_product', 'get_order', 'list_orders', 'list_products', 'update_order_status']);
  const a = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  assert.equal(a.list_orders.readOnlyHint, true); assert.equal(a.create_product.readOnlyHint, false); assert.equal(a.update_order_status.destructiveHint, true);
  await c.close();
});

test('MCP endpoint requires the bearer token (no token / wrong token => 401); healthz is open', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }); const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(mcpBase + '/mcp', { method: 'POST', headers: h, body })).status, 401);
  assert.equal((await fetch(mcpBase + '/mcp', { method: 'POST', headers: { ...h, authorization: 'Bearer wrong' }, body })).status, 401);
  assert.equal((await fetch(mcpBase + '/healthz')).status, 200);
  await assert.rejects(client('wrong'));
});

test('list_products: sends Basic auth + forwarded-proto to WooCommerce, passes filters, returns shaped products', async () => {
  const c = await client(); const r = data(await c.callTool({ name: 'list_products', arguments: { search: 'mug', per_page: 5 } }));
  assert.equal(r[0].name, 'Mug'); assert.equal(r[0].url, 'http://shop.local/product/mug/');
  assert.equal(last().path, '/products'); assert.equal(last().query.search, 'mug'); assert.equal(last().query.per_page, '5');
  assert.equal(last().auth, 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64')); assert.equal(last().xfp, 'https');
  await c.close();
});

test('create_product: posts a simple published product; returns id + storefront URL', async () => {
  const c = await client(); const r = data(await c.callTool({ name: 'create_product', arguments: { name: 'Blue Notebook', regular_price: '199.50' } }));
  assert.equal(last().method, 'POST'); assert.deepEqual({ ...last().body }, { name: 'Blue Notebook', type: 'simple', regular_price: '199.50', status: 'publish' });
  assert.equal(r.id, 12); assert.equal(r.price, '199.50'); assert.ok(r.url.startsWith('http'));
  await c.close();
});

test('create_product rejects bad input BEFORE calling WooCommerce (price format, empty/oversized name, unknown fields ignored)', async () => {
  const c = await client(); const n = wcLog.length;
  for (const args of [{ name: 'x', regular_price: '-5' }, { name: 'x', regular_price: '1e9' }, { name: 'x', regular_price: '10.999' }, { name: '', regular_price: '1' }, { name: 'x'.repeat(201), regular_price: '1' }, { regular_price: '1' }]) {
    const r = await c.callTool({ name: 'create_product', arguments: args }).catch((e) => ({ isError: true, thrown: e.message }));
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(wcLog.length, n, 'invalid input must never reach WooCommerce');
  await c.close();
});

test('list_orders: created_today uses STORE timezone (IST), newest first; PII (email/phone/address) is NOT returned', async () => {
  assert.equal(startOfToday('Asia/Kolkata', new Date('2026-10-19T20:00:00Z')), '2026-10-20T00:00:00');
  assert.equal(startOfToday('UTC', new Date('2026-10-19T20:00:00Z')), '2026-10-19T00:00:00');
  const c = await client(); const raw = await c.callTool({ name: 'list_orders', arguments: { created_today: true } }); const r = data(raw);
  assert.equal(last().query.after, '2026-10-20T00:00:00'); assert.equal(last().query.orderby, 'date'); assert.equal(last().query.order, 'desc'); assert.equal(last().query.status, 'any');
  assert.equal(r.count, 1); assert.equal(r.orders[0].items[0].name, 'Mug'); assert.equal(r.orders[0].total, '18.00');
  const text = raw.content[0].text; for (const pii of ['asha@example.com', '9999999999', 'MG Road', 'Asha', 'billing']) assert.ok(!text.includes(pii), `leaked ${pii}`);
  await c.close();
});

test('list_orders validates dates/status; get_order + update_order_status work; bad status rejected before WC', async () => {
  const c = await client(); const n = wcLog.length;
  assert.equal((await c.callTool({ name: 'list_orders', arguments: { after: 'yesterday' } }).catch(() => ({ isError: true }))).isError, true);
  assert.equal((await c.callTool({ name: 'update_order_status', arguments: { id: 101, status: 'hacked' } }).catch(() => ({ isError: true }))).isError, true);
  assert.equal(wcLog.length, n);
  assert.equal(data(await c.callTool({ name: 'get_order', arguments: { id: 101 } })).id, 101);
  const u = data(await c.callTool({ name: 'update_order_status', arguments: { id: 101, status: 'completed' } }));
  assert.equal(last().method, 'PUT'); assert.deepEqual({ ...last().body }, { status: 'completed' }); assert.equal(u.status, 'completed');
  await c.close();
});

test('errors: unknown order => clean not-found; WC 401 => credential message w/o secrets; WC 500 => html stripped; timeout; unreachable', async () => {
  const c = await client();
  let r = await c.callTool({ name: 'get_order', arguments: { id: 999 } }); assert.equal(r.isError, true); assert.match(r.content[0].text, /Invalid ID/);
  forceStatus = 401; r = await c.callTool({ name: 'list_products', arguments: {} }); forceStatus = 0;
  assert.match(r.content[0].text, /rejected the API credentials/); assert.ok(!r.content[0].text.includes(SECRET) && !r.content[0].text.includes(KEY));
  forceStatus = 500; r = await c.callTool({ name: 'list_products', arguments: {} }); forceStatus = 0;
  assert.ok(r.isError && !r.content[0].text.includes('<b>'));
  delayMs = 800; const t0 = Date.now(); r = await c.callTool({ name: 'list_products', arguments: {} }); delayMs = 0;
  assert.ok(r.isError && /did not answer within 300ms/.test(r.content[0].text) && Date.now() - t0 < 700);
  await c.close();
  // WooCommerce completely down
  const dead = createApp({ wcBaseUrl: 'http://127.0.0.1:1', wcKey: KEY, wcSecret: SECRET, mcpToken: TOKEN, wcTimeoutMs: 300, timezone: 'UTC' }, { log: () => {} });
  const s = http.createServer(dead); await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const c2 = new Client({ name: 't', version: '1' }); await c2.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.address().port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  r = await c2.callTool({ name: 'list_products', arguments: {} }); assert.ok(r.isError && /Cannot reach WooCommerce/.test(r.content[0].text));
  await c2.close(); s.closeAllConnections(); s.close();
});

test('shapeOrder drops unknown/sensitive fields even if WooCommerce adds new ones', () => {
  const o = shapeOrder({ ...ORDER, customer_ip_address: '1.2.3.4', meta_data: [{ key: 'secret', value: 'x' }] });
  assert.ok(!JSON.stringify(o).includes('1.2.3.4') && !JSON.stringify(o).includes('meta_data'));
});
