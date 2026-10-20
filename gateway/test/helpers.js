import http from 'node:http';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openDb } from '../src/db/database.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { generateApiKey } from '../src/security/apikeys.js';

export const ORIGIN = 'http://dash.test';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv, port = 0) => new Promise((res) => srv.listen(port, '127.0.0.1', () => res(srv.address().port)));

// ---- a REAL MCP server (official SDK, Streamable HTTP, stateless) to act as an upstream ----
export async function startUpstream({ name, token, port = 0, tools = {} }) {
  const seen = []; // headers of every request, so tests can prove what the gateway forwards
  const app = express(); app.use(express.json());
  app.post('/mcp', async (req, res) => {
    seen.push({ ...req.headers, _rpc: req.body?.method });
    if (token && req.headers.authorization !== `Bearer ${token}`) return res.status(401).json({ error: 'nope' });
    const s = new McpServer({ name, version: '1.0.0' });
    for (const [tname, t] of Object.entries(tools))
      s.registerTool(tname, { description: t.description ?? `${name} ${tname}`, inputSchema: t.schema ?? { text: z.string().optional() } }, t.handler);
    const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { tr.close(); s.close(); });
    await s.connect(tr); await tr.handleRequest(req, res, req.body);
  });
  const srv = http.createServer(app);
  const p = await listen(srv, port);
  return { port: p, url: `http://127.0.0.1:${p}/mcp`, seen, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}
export const textTool = (fn) => ({ handler: async (args) => ({ content: [{ type: 'text', text: fn(args) }] }) });

// ---- gateway under test, on a random port, with fast timeouts ----
export async function startGateway(over = {}) {
  const clock = { t: Date.now() };
  const db = openDb(':memory:', { clock: () => new Date(clock.t) });
  const logs = [];
  const logger = createLogger({ level: 'debug', sink: (l) => logs.push(l) });
  const adminKey = generateApiKey();
  db.bootstrapAdmin({ email: 'admin@x.com', rawKey: adminKey.raw });
  const config = {
    prod: false, encryptionKey: randomBytes(32), allowedOrigins: [ORIGIN], mcpAllowedOrigins: [ORIGIN],
    cookie: { secure: false, sameSite: 'Strict', name: 'umk_session' },
    sessionTtlMs: 60 * 60_000, sessionIdleMs: 10 * 60_000, trustProxy: 0, loginRateLimit: { max: 5, windowMs: 60_000 },
    upstream: { allowlist: ['127.0.0.1'], allowPrivate: false },
    timeouts: { connectMs: 1500, listMs: 1500, callMs: 400, refreshMs: 3_600_000, cooldownMs: 300 },
    maxResultBytes: 2000, maxArgBytes: 10_000, ...over,
  };
  const { app, manager } = createApp({ db, config, logger });
  const srv = http.createServer(app); const port = await listen(srv);
  const base = `http://127.0.0.1:${port}`;
  return { db, clock, logs, adminKey: adminKey.raw, base, manager, config,
    close: async () => { manager.stop(); srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); } };
}

// ---- tiny REST client. Auth is either cookie session (+csrf) or bearer key ----
export function api(base) {
  const call = async (method, path, { body, key, cookie, csrf, origin, headers = {} } = {}) => {
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (key) h.authorization = `Bearer ${key}`;
    if (cookie) h.cookie = cookie;
    if (csrf) h['x-csrf-token'] = csrf;
    if (origin) h.origin = origin;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return call;
}
export async function login(call, apiKey, origin = ORIGIN) {
  const r = await call('POST', '/api/auth/login', { body: { apiKey }, origin });
  const setCookie = r.headers.getSetCookie?.()[0] ?? '';
  return { ...r, cookie: setCookie.split(';')[0], setCookie, csrf: r.json?.csrfToken };
}

// ---- a real external MCP client (official SDK) pointed at the gateway with only URL + key ----
export async function mcpClient(base, key) {
  const c = new Client({ name: 'test-client', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return c;
}
export const textOf = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
