// GatewayService = the single choke-point for "list tools" and "call a tool".
// Both the external MCP endpoint (/mcp) and the dashboard chat agent go through here, which guarantees that
// authorization (per-user rules) and audit logging cannot be skipped by using a different entry path.
import { GatewayError, errorResult, safeText } from './errors.js';

const SLUG_TOOL = /^([a-z][a-z0-9-]{1,29})__(.+)$/;

export class GatewayService {
  constructor({ db, manager, logger, limits }) { Object.assign(this, { db, manager, logger, limits }); this.manager.maxResultBytes = limits.maxResultBytes; }

  listTools(user) {
    return this.manager.listTools()
      .filter((t) => !this.db.isToolDenied(user, t.slug, t.tool)) // hidden, not just rejected
      .map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) }));
  }

  async callTool({ user, source, name, args, signal }) {
    const t0 = performance.now();
    let slug = null, tool = typeof name === 'string' ? name.slice(0, 80) : null, success = false, summary = null, result;
    try {
      const m = typeof name === 'string' ? SLUG_TOOL.exec(name) : null; // split at FIRST "__" (slugs can't contain "__")
      if (!m) throw new GatewayError('unknown_tool', 'Tool not available');
      [, slug, tool] = m;
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new GatewayError('invalid_arguments', 'Tool arguments must be an object');
      if (args && JSON.stringify(args).length > this.limits.maxArgBytes) throw new GatewayError('invalid_arguments', 'Tool arguments too large');
      if (this.db.isToolDenied(user, slug, tool)) { summary = 'forbidden'; throw new GatewayError('unknown_tool', 'Tool not available'); } // same message as unknown: don't reveal hidden tools
      result = await this.manager.call({ slug, tool, args, signal });
      success = !result.isError;
      if (!success) summary = 'tool_error: ' + safeText(result.content?.find((c) => c.type === 'text')?.text ?? 'upstream tool reported an error', 120);
    } catch (e) {
      if (!(e instanceof GatewayError)) { this.logger.error('call_failed_unexpected', { error: e }); e = new GatewayError('internal', 'Internal gateway error'); }
      summary ??= e.code + ': ' + safeText(e.message, 140);
      result = errorResult(e.message);
    }
    this.db.audit({ userId: user.id, userEmail: user.email, source, serverSlug: slug, tool, durationMs: Math.round(performance.now() - t0), success, errorSummary: summary });
    return result;
  }
}
