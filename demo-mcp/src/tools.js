// Two tiny, honest, self-written demo MCP servers (NOT third-party). One image, two "personalities" via MODE.
//   utils : current_date, calculate           -> lets the agent answer "orders today" (needs the date) + math
//   notes : add_note, list_notes, search_notes -> in-memory scratchpad (state is lost on restart; documented)
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { calculate } from './calc.js';

const ok = (d) => ({ content: [{ type: 'text', text: typeof d === 'string' ? d : JSON.stringify(d, null, 2) }] });
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: t }] });
const ro = { readOnlyHint: true, openWorldHint: false };

export function buildUtilsServer({ now = () => new Date() } = {}) {
  const s = new McpServer({ name: 'urumi-demo-utils', version: '0.1.0' });
  s.registerTool('current_date', {
    description: 'Get the current date and time, optionally in an IANA timezone (e.g. "Asia/Kolkata"). Use this before asking for "today\'s" data.',
    inputSchema: { timezone: z.string().max(64).default('UTC') }, annotations: ro,
  }, async ({ timezone }) => {
    try {
      const d = now(); const f = (o) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, ...o }).format(d);
      return ok({ timezone, date: f({ year: 'numeric', month: '2-digit', day: '2-digit' }), time: new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d), iso_utc: d.toISOString() });
    } catch { return fail(`Unknown timezone "${timezone}". Use an IANA name like "UTC" or "Asia/Kolkata".`); }
  });
  s.registerTool('calculate', {
    description: 'Evaluate an arithmetic expression using + - * / % and parentheses, e.g. "(19.99 * 3) + 5".',
    inputSchema: { expression: z.string().min(1).max(200) }, annotations: ro,
  }, async ({ expression }) => { try { return ok({ expression, result: calculate(expression) }); } catch (e) { return fail(`Cannot evaluate: ${e.message}`); } });
  return s;
}

export function createNotesStore({ maxNotes = 200 } = {}) {
  const notes = []; let seq = 0;
  return { notes, add(text) { if (notes.length >= maxNotes) throw new Error(`note limit (${maxNotes}) reached`); const n = { id: ++seq, text, created_at: new Date().toISOString() }; notes.push(n); return n; } };
}
export function buildNotesServer(store) {
  const s = new McpServer({ name: 'urumi-demo-notes', version: '0.1.0' });
  s.registerTool('add_note', { description: 'Save a short text note.', inputSchema: { text: z.string().min(1).max(2000) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    async ({ text }) => { try { return ok(store.add(text)); } catch (e) { return fail(e.message); } });
  s.registerTool('list_notes', { description: 'List saved notes (newest first).', inputSchema: { limit: z.number().int().min(1).max(50).default(10) }, annotations: ro },
    async ({ limit }) => ok(store.notes.slice(-limit).reverse()));
  s.registerTool('search_notes', { description: 'Find notes containing a text fragment (case-insensitive).', inputSchema: { query: z.string().min(1).max(100) }, annotations: ro },
    async ({ query }) => ok(store.notes.filter((n) => n.text.toLowerCase().includes(query.toLowerCase())).slice(-20).reverse()));
  return s;
}
