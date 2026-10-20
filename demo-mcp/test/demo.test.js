import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { calculate } from '../src/calc.js';

test('calculator: correct precedence/parentheses; rejects code, garbage, div-by-zero, deep nesting', () => {
  assert.equal(calculate('2 + 3 * 4'), 14); assert.equal(calculate('(2+3)*4'), 20); assert.equal(calculate('-(19.99*3)+100').toFixed(2), '40.03'); assert.equal(calculate('10 % 4'), 2);
  for (const bad of ['process.exit(1)', '2 +', '1/0', '1 % 0', '(((1)', 'alert(1)', '2 ** 3', '', '1;2', '('.repeat(100) + '1' + ')'.repeat(100), '9'.repeat(300)])
    assert.throws(() => calculate(bad), undefined, bad);
});

const start = async (mode, now) => { const s = http.createServer(createApp({ mode, token: 'tok', now })); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const c = new Client({ name: 't', version: '1' }); await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.address().port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer tok' } } }));
  return { c, url: `http://127.0.0.1:${s.address().port}`, stop: async () => { await c.close(); s.closeAllConnections(); s.close(); } }; };

test('utils server: current_date honours timezone (IST vs UTC across midnight); bad timezone => tool error; calculate works', async () => {
  const u = await start('utils', () => new Date('2026-10-19T20:00:00Z'));
  assert.deepEqual((await u.c.listTools()).tools.map((t) => t.name).sort(), ['calculate', 'current_date']);
  const ist = JSON.parse((await u.c.callTool({ name: 'current_date', arguments: { timezone: 'Asia/Kolkata' } })).content[0].text);
  assert.equal(ist.date, '2026-10-20'); assert.equal(ist.time, '01:30:00');
  assert.equal(JSON.parse((await u.c.callTool({ name: 'current_date', arguments: {} })).content[0].text).date, '2026-10-19');
  assert.equal((await u.c.callTool({ name: 'current_date', arguments: { timezone: 'Mars/Base' } })).isError, true);
  assert.equal(JSON.parse((await u.c.callTool({ name: 'calculate', arguments: { expression: '(19.99*3)+5' } })).content[0].text).result.toFixed(2), '64.97');
  assert.equal((await u.c.callTool({ name: 'calculate', arguments: { expression: 'process.exit(1)' } })).isError, true);
  await u.stop();
});

test('notes server: add/list/search; endpoint needs bearer token; unknown MODE refused', async () => {
  const n = await start('notes');
  await n.c.callTool({ name: 'add_note', arguments: { text: 'Order 101 needs gift wrap' } }); await n.c.callTool({ name: 'add_note', arguments: { text: 'restock mugs' } });
  assert.equal(JSON.parse((await n.c.callTool({ name: 'list_notes', arguments: {} })).content[0].text)[0].text, 'restock mugs');
  assert.equal(JSON.parse((await n.c.callTool({ name: 'search_notes', arguments: { query: 'GIFT' } })).content[0].text).length, 1);
  const r = await fetch(n.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' }); assert.equal(r.status, 401);
  await n.stop();
  assert.throws(() => createApp({ mode: 'bogus', token: 't' }));
});
