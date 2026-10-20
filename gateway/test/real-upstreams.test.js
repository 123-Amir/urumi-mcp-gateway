// Integration: gateway + the REAL woo-mcp and demo-mcp code (only WooCommerce itself is faked, because WordPress/MySQL
// cannot run in this sandbox). Mirrors assignment scenarios 4,5,6,8,9,10 at the protocol level.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createApp as createWoo } from '../../woo-mcp/src/app.js';
import { createApp as createDemo } from '../../demo-mcp/src/app.js';
import { startGateway, api, mcpClient, textOf } from './helpers.js';

const listen = async (app) => { const s = http.createServer(app); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return { s, url: `http://127.0.0.1:${s.address().port}`, stop: () => { s.closeAllConnections(); return new Promise((r) => s.close(r)); } }; };
let gw, call, fakeWc, woo, utils, notes; const products = []; const orders = [];

before(async () => {
  const wc = express(); wc.use(express.json());
  wc.use('/wp-json/wc/v3', (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('ck:cs').toString('base64')) return res.status(401).json({ message: 'no' });
    if (req.method === 'POST' && req.path === '/products') { const p = { id: 100 + products.length, name: req.body.name, status: req.body.status, price: req.body.regular_price, regular_price: req.body.regular_price, stock_status: 'instock', permalink: `http://shop/p/${products.length}` }; products.push(p); return res.status(201).json(p); }
    if (req.method === 'GET' && req.path === '/products') return res.json(products);
    if (req.method === 'GET' && req.path === '/orders') return res.json(orders.filter((o) => !req.query.after || o.date_created >= req.query.after));
    res.status(404).json({ message: 'no route' });
  });
  fakeWc = await listen(wc);
  woo = await listen(createWoo({ wcBaseUrl: fakeWc.url, wcKey: 'ck', wcSecret: 'cs', mcpToken: 'woo-internal-token', wcTimeoutMs: 500, timezone: 'UTC' }, { log: () => {} }));
  utils = await listen(createDemo({ mode: 'utils', token: 'utils-token' }));
  notes = await listen(createDemo({ mode: 'notes', token: 'notes-token' }));
  gw = await startGateway(); call = api(gw.base);
  for (const [slug, name, url, credential] of [['woo', 'WooCommerce', woo.url + '/mcp', 'woo-internal-token'], ['utils', 'Utilities', utils.url + '/mcp', 'utils-token'], ['notes', 'Notes', notes.url + '/mcp', 'notes-token']]) {
    const r = await call('POST', '/api/servers', { body: { slug, name, url, authType: 'bearer', credential }, key: gw.adminKey });
    assert.equal(r.json.server.status, 'connected', `${slug}: ${JSON.stringify(r.json)}`);
  }
});
after(async () => { await gw.close(); for (const x of [woo, utils, notes, fakeWc]) await x.stop(); });
const user = async (email) => { const r = await call('POST', '/api/users', { body: { email, name: email, role: 'member' }, key: gw.adminKey }); return { id: r.json.user.id, key: r.json.apiKey.key }; };

test('user B (URL + key only) discovers tools from ALL THREE upstreams through one endpoint', async () => {
  const b = await user('b@x.com'); const c = await mcpClient(gw.base, b.key);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['notes__add_note', 'notes__list_notes', 'notes__search_notes', 'utils__calculate', 'utils__current_date', 'woo__create_product', 'woo__get_order', 'woo__list_orders', 'woo__list_products', 'woo__update_order_status']);
  assert.ok(names.every((n) => n.length <= 64));
  await c.close();
});

test('user A creates a product via gateway -> real woo-mcp -> (fake) WooCommerce; product is then listed', async () => {
  const a = await user('a@x.com'); const c = await mcpClient(gw.base, a.key);
  const created = JSON.parse(textOf(await c.callTool({ name: 'woo__create_product', arguments: { name: 'Steel Bottle', regular_price: '349' } })));
  assert.equal(created.name, 'Steel Bottle'); assert.equal(created.status, 'publish');
  assert.ok(JSON.parse(textOf(await c.callTool({ name: 'woo__list_products', arguments: {} }))).some((p) => p.name === 'Steel Bottle'));
  await c.close();
});

test('TWO-UPSTREAM prompt flow: utils__current_date -> woo__list_orders(today); audit attributes each call to the right user + server', async () => {
  const b = await user('b2@x.com'); const c = await mcpClient(gw.base, b.key);
  const today = JSON.parse(textOf(await c.callTool({ name: 'utils__current_date', arguments: { timezone: 'UTC' } }))).date;
  orders.push({ id: 7, number: '7', status: 'processing', total: '349.00', currency: 'INR', date_created: `${today}T09:00:00`, payment_method_title: 'Cash on delivery', customer_id: 0, billing: { email: 'pii@x.com' }, line_items: [{ product_id: 100, name: 'Steel Bottle', quantity: 1, total: '349.00' }] });
  const r = JSON.parse(textOf(await c.callTool({ name: 'woo__list_orders', arguments: { created_today: true } })));
  assert.equal(r.count, 1); assert.equal(r.orders[0].items[0].name, 'Steel Bottle'); assert.ok(!JSON.stringify(r).includes('pii@x.com'));
  const mine = (await call('GET', '/api/audit', { key: b.key })).json.entries.filter((e) => e.source === 'mcp').map((e) => `${e.server}.${e.tool}:${e.success}`).reverse();
  assert.deepEqual(mine, ['utils.current_date:true', 'woo.list_orders:true']);
  await c.close();
});

test('disable utils => its tools vanish; kill woo-mcp => woo unreachable, utils/notes keep working', async () => {
  const b = await user('b3@x.com'); const c = await mcpClient(gw.base, b.key);
  const id = (await call('GET', '/api/servers', { key: gw.adminKey })).json.servers.find((s) => s.slug === 'notes').id;
  await call('PATCH', `/api/servers/${id}`, { body: { enabled: false }, key: gw.adminKey });
  assert.ok(!(await c.listTools()).tools.some((t) => t.name.startsWith('notes__')));
  await woo.stop();                                              // == kubectl delete pod woo-mcp
  const dead = await c.callTool({ name: 'woo__list_products', arguments: {} }); assert.equal(dead.isError, true); assert.match(textOf(dead), /unreachable/);
  assert.equal(JSON.parse(textOf(await c.callTool({ name: 'utils__calculate', arguments: { expression: '6*7' } }))).result, 42);
  assert.equal((await call('GET', '/api/servers', { key: gw.adminKey })).json.servers.find((s) => s.slug === 'woo').status, 'unreachable');
  await c.close();
});
