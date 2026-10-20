// The gateway's own MCP server endpoint: POST /mcp (Streamable HTTP).
//
// STATELESS mode: every HTTP request gets a fresh MCP Server+transport, authenticated with the Bearer key on THAT request.
//  + revoked key => the very next request is 401 (no long-lived session to invalidate)
//  + no session map in memory => survives restarts, and works with several gateway replicas later
//  - no server->client push (tools/list_changed) and no GET/SSE stream; clients just re-list tools. Acceptable for tools-only gateway.
// Cookies are deliberately NOT accepted here: only an explicit Bearer key. That removes CSRF from the MCP surface entirely.
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { extractKey } from '../security/apikeys.js';

export function mountMcp(app, { db, service, config, logger, version = '0.1.0' }) {
  const parse = express.json({ limit: '1mb' });
  const rpcError = (res, status, code, message) => res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });

  app.post('/mcp', parse, async (req, res) => {
    const origin = req.headers.origin; // MCP spec: validate Origin to stop DNS-rebinding style browser attacks
    if (origin !== undefined && !config.mcpAllowedOrigins.includes(origin)) return rpcError(res, 403, -32000, 'Origin not allowed');
    const key = extractKey(req.headers);
    const user = key ? db.authenticate(key) : null;
    if (!user) { res.setHeader('WWW-Authenticate', 'Bearer realm="urumi-mcp-gateway"'); return rpcError(res, 401, -32001, 'Unauthorized'); }

    const server = new Server({ name: 'urumi-mcp-gateway', version },
      { capabilities: { tools: {} }, instructions: 'Tools are namespaced as <server>__<tool>.' });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: service.listTools(user) }));
    server.setRequestHandler(CallToolRequestSchema, async (r, extra) =>
      service.callTool({ user, source: 'mcp', name: r.params.name, args: r.params.arguments, signal: extra.signal }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (e) { logger.error('mcp_request_failed', { error: e }); if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error'); }
  });
  const notAllowed = (req, res) => { res.setHeader('Allow', 'POST'); rpcError(res, 405, -32000, 'Method not allowed (stateless server)'); };
  app.get('/mcp', notAllowed); app.delete('/mcp', notAllowed);
}
