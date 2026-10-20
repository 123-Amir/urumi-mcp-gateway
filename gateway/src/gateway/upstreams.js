// UpstreamManager = the gateway acting as an MCP *client* to every registered upstream server.
//
// Key ideas (each one exists because of a failure mode from the assignment):
//  * Tool lists are CACHED per server and refreshed in the background. tools/list from a user therefore never waits on the
//    network, so a slow/dead upstream cannot slow down or break listing for healthy ones.
//  * Every network step has its own timeout; calls never hang forever.
//  * A failed connect puts the server in "unreachable" with a short cooldown => calls fail fast instead of each paying the
//    full connect timeout against a dead host.
//  * Tool calls are NEVER auto-retried (create_product retried after an ambiguous failure could create a duplicate).
//  * Upstream output is untrusted: names validated, descriptions capped + control chars stripped, schemas size-capped,
//    results size-capped.
//  * The caller's gateway API key is never forwarded; only the server's own stored credential is attached.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { assertSafeUpstreamUrl } from '../security/ssrf.js';
import { decrypt } from '../security/secretbox.js';
import { GatewayError, safeText, clip } from './errors.js';

class TimeoutError extends Error {}
const withTimeout = (p, ms, label) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new TimeoutError(`${label} timed out after ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(t));
};
const closeQuietly = (c) => { try { Promise.resolve(c?.close()).catch(() => {}); } catch { /* ignore */ } };

const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/; // slug<=30 + "__" + tool<=32 = 64 = common MCP-client limit
const MAX_TOOLS_PER_SERVER = 200, MAX_PAGES = 10, MAX_SCHEMA_BYTES = 16 * 1024, MAX_DESC = 600;

export function classify(e) {
  if (e instanceof TimeoutError || e?.name === 'AbortError' || (e instanceof McpError && e.code === ErrorCode.RequestTimeout)) return 'timeout';
  if (e instanceof McpError) return e.code === ErrorCode.ConnectionClosed ? 'connection' : 'protocol'; // protocol = upstream answered with a JSON-RPC error: it is alive
  if (e?.name === 'ZodError') return 'malformed';
  return 'connection';
}
function reason(e) {
  const code = e?.cause?.code ?? e?.code;
  return safeText(typeof code === 'string' ? `${code}` : (e?.message ?? 'unknown error'), 120);
}

function sanitizeTool(slug, t) {
  if (!t || typeof t.name !== 'string' || !TOOL_NAME_RE.test(t.name)) return null;
  const schema = t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object' ? t.inputSchema : { type: 'object', properties: {} };
  if (JSON.stringify(schema).length > MAX_SCHEMA_BYTES) return null;
  const desc = clip(String(t.description ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' '), MAX_DESC);
  return { slug, tool: t.name, name: `${slug}__${t.name}`,
    description: `[${slug}] ${desc}`.trim(), // attribution prefix: model + humans can see which server wrote this text
    inputSchema: schema, annotations: t.annotations && typeof t.annotations === 'object' ? t.annotations : undefined };
}

export class UpstreamManager {
  constructor({ db, secretKey, ssrf, timeouts, logger, version = '0.1.0' }) {
    Object.assign(this, { db, secretKey, ssrf, timeouts, logger, version });
    this.states = new Map(); // serverId -> state
    this.timer = null;
  }

  start() {
    this.refreshAll().catch((e) => this.logger.error('initial_refresh_failed', { error: e }));
    this.timer = setInterval(() => this.refreshAll().catch((e) => this.logger.error('refresh_failed', { error: e })), this.timeouts.refreshMs);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); for (const s of this.states.values()) closeQuietly(s.client); this.states.clear(); }

  #state(id) {
    let s = this.states.get(id);
    if (!s) { s = { client: null, status: 'connecting', error: null, tools: [], failedAt: 0, lastCheckedAt: null, refreshing: null }; this.states.set(id, s); }
    return s;
  }

  // Called when an admin edits/disables/removes a server: drop the old connection so new URL/credential is used.
  invalidate(id) { const s = this.states.get(id); this.states.delete(id); if (s) closeQuietly(s.client); }

  #headers(server) {
    if (server.auth_type === 'none' || !server.credential_enc) return {};
    const secret = decrypt(server.credential_enc, this.secretKey); // decrypted only here, only for the outgoing request
    return server.auth_type === 'bearer' ? { Authorization: `Bearer ${secret}` } : { [server.auth_header_name]: secret };
  }

  async #connect(server) {
    const url = await assertSafeUpstreamUrl(server.url, this.ssrf); // re-checked on EVERY connect (narrows DNS-rebinding window)
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: this.#headers(server) } }); // redirects are NOT followed by default
    const client = new Client({ name: 'urumi-gateway', version: this.version }, { capabilities: {} });
    try { await withTimeout(client.connect(transport, { timeout: this.timeouts.connectMs }), this.timeouts.connectMs + 250, 'connect'); }
    catch (e) { closeQuietly(client); throw e; }
    return client;
  }

  #markDown(server, st, e) {
    const prev = st.status;
    st.status = 'unreachable'; st.failedAt = Date.now(); st.error = `${classify(e)}: ${reason(e)}`;
    closeQuietly(st.client); st.client = null;
    if (prev !== 'unreachable') this.logger.warn('upstream_unreachable', { server: server.slug, reason: st.error });
  }

  async #ensureClient(server, st, { force = false } = {}) {
    if (st.client) return st.client;
    if (!force && st.status === 'unreachable' && Date.now() - st.failedAt < this.timeouts.cooldownMs)
      throw new GatewayError('unreachable', `Upstream "${server.slug}" is unreachable (${st.error})`); // fail fast
    st.connecting ??= this.#connect(server).finally(() => { st.connecting = null; }); // one connect at a time per server
    const client = await st.connecting;
    if (this.states.get(server.id) !== st) { closeQuietly(client); throw new GatewayError('unreachable', `Upstream "${server.slug}" was reconfigured`); }
    st.client = client;
    return client;
  }

  async #listAll(client, slug) {
    const out = []; const seen = new Set(); let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await withTimeout(client.listTools(cursor ? { cursor } : {}, { timeout: this.timeouts.listMs }), this.timeouts.listMs + 250, 'tools/list');
      for (const t of r.tools) {
        const s = sanitizeTool(slug, t);
        if (s && !seen.has(s.name) && out.length < MAX_TOOLS_PER_SERVER) { seen.add(s.name); out.push(s); }
      }
      cursor = r.nextCursor; if (!cursor) break;
    }
    return out;
  }

  // Connect (if needed) + refresh the cached tool list for one server. Never throws: failure => status "unreachable".
  refreshServer(server) {
    if (!server.enabled) { this.invalidate(server.id); return Promise.resolve(); }
    const st = this.#state(server.id);
    if (st.refreshing) return st.refreshing;
    st.refreshing = (async () => {
      try {
        const client = await this.#ensureClient(server, st, { force: true });
        st.tools = await this.#listAll(client, server.slug);
        const was = st.status; st.status = 'connected'; st.error = null;
        if (was !== 'connected') this.logger.info('upstream_connected', { server: server.slug, tools: st.tools.length });
      } catch (e) { this.#markDown(server, st, e); }
      finally { st.lastCheckedAt = new Date().toISOString(); st.refreshing = null; }
    })();
    return st.refreshing;
  }

  async refreshAll() {
    const servers = this.db.listServers();
    const live = new Set(servers.filter((s) => s.enabled).map((s) => s.id));
    for (const id of [...this.states.keys()]) if (!live.has(id)) this.invalidate(id); // removed/disabled => close
    await Promise.allSettled(servers.filter((s) => s.enabled).map((s) => this.refreshServer(s))); // parallel: one slow server cannot delay others
  }

  // ---- read side ----
  describe(server) {
    if (!server.enabled) return { status: 'disabled', tools: [] };
    const st = this.states.get(server.id);
    if (!st) return { status: 'connecting', tools: [] };
    return { status: st.status, error: st.error, lastCheckedAt: st.lastCheckedAt,
      tools: st.tools.map((t) => ({ name: t.tool, namespacedName: t.name, description: t.description })) };
  }
  // Tools visible through the gateway: ONLY enabled + currently connected servers. Pure memory read => never blocks.
  listTools() {
    const out = [];
    for (const server of this.db.listEnabledServers()) {
      const st = this.states.get(server.id);
      if (st?.status === 'connected') out.push(...st.tools);
    }
    return out;
  }

  // ---- call side ----
  async call({ slug, tool, args, signal }) {
    const server = this.db.getServerBySlug(slug);
    if (!server || !server.enabled) throw new GatewayError('unknown_tool', 'Tool not available');
    const st = this.states.get(server.id);
    const known = st?.tools.find((t) => t.tool === tool); // only tools that passed sanitation are callable
    if (!known) {
      if (!st || st.status !== 'connected')
        throw new GatewayError('unreachable', st?.status === 'unreachable' ? `Upstream "${slug}" is unreachable (${st.error})` : `Upstream "${slug}" is still connecting`);
      throw new GatewayError('unknown_tool', 'Tool not available');
    }
    let client;
    try { client = await this.#ensureClient(server, st); }
    catch (e) {
      if (e instanceof GatewayError) throw e;
      this.#markDown(server, st, e);
      throw new GatewayError(classify(e) === 'timeout' ? 'timeout' : 'unreachable', `Upstream "${slug}" is unreachable (${st.error})`);
    }
    try {
      const res = await withTimeout(client.callTool({ name: tool, arguments: args ?? {} }, undefined, { timeout: this.timeouts.callMs, signal }), this.timeouts.callMs + 250, 'tool call');
      return this.#limit(res);
    } catch (e) {
      const kind = classify(e);
      if (kind === 'timeout') { this.refreshServer(server); throw new GatewayError('timeout', `Upstream "${slug}" timed out after ${this.timeouts.callMs}ms`); }
      if (kind === 'protocol') throw new GatewayError('upstream_error', `Upstream "${slug}" rejected the call: ${safeText(e.message)}`);
      if (kind === 'malformed') throw new GatewayError('malformed', `Upstream "${slug}" returned a malformed response`);
      this.#markDown(server, st, e); this.refreshServer(server);
      throw new GatewayError('unreachable', `Upstream "${slug}" is unreachable (${st.error})`);
    }
  }

  // Cap output size so a hostile/buggy upstream cannot blow up gateway memory or the LLM context.
  #limit(res) {
    let budget = this.maxResultBytes ?? 256 * 1024; const content = [];
    for (const c of res.content ?? []) {
      if (c.type === 'text') { const t = String(c.text ?? ''); content.push({ type: 'text', text: t.length > budget ? t.slice(0, Math.max(budget, 0)) + '\n[gateway: output truncated]' : t }); budget -= t.length; }
      else { const size = JSON.stringify(c).length; if (size > budget) content.push({ type: 'text', text: '[gateway: non-text content omitted, too large]' }); else { content.push(c); budget -= size; } }
    }
    const out = { content, isError: !!res.isError };
    if (res.structuredContent && JSON.stringify(res.structuredContent).length <= budget) out.structuredContent = res.structuredContent;
    return out;
  }
}
