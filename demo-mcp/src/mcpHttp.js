// Shared pattern: stateless MCP Streamable HTTP endpoint protected by a static bearer token.
// Why a token if the service is already cluster-internal + NetworkPolicy'd? Defense in depth: if a NetworkPolicy is
// missing/misconfigured (or a CNI doesn't enforce it, e.g. default kind), a random pod still cannot call the tools.
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const digest = (s) => createHash('sha256').update(s).digest(); // equal-length buffers => timingSafeEqual never throws, no length leak

export function mountMcp(app, { buildServer, token, log = () => {} }) {
  const want = digest(token);
  app.post('/mcp', express.json({ limit: '256kb' }), async (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (!m || !timingSafeEqual(digest(m[1]), want)) return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (e) { log('mcp_error', e.message); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }); }
  });
  const no = (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', no); app.delete('/mcp', no);
  app.get('/healthz', (req, res) => res.json({ ok: true })); // liveness + readiness: process can serve (doesn't call WooCommerce on purpose)
}
