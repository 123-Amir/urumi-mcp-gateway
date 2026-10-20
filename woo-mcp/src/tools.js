import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WcError } from './wc.js';

const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'];
const PRICE = /^\d{1,9}(\.\d{1,2})?$/;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?)?$/;

// PRIVACY: WooCommerce returns billing/shipping names, emails, phones, addresses. The model/chat/MCP clients don't need
// them to answer "what orders came in today", so we whitelist only business fields (data minimisation).
export const shapeProduct = (p) => ({ id: p.id, name: p.name, status: p.status, price: p.price, regular_price: p.regular_price,
  stock_status: p.stock_status, sku: p.sku || undefined, url: p.permalink });
export const shapeOrder = (o) => ({ id: o.id, number: o.number, status: o.status, total: o.total, currency: o.currency, date_created: o.date_created,
  payment_method: o.payment_method_title || o.payment_method, customer_id: o.customer_id,
  items: (o.line_items ?? []).map((i) => ({ product_id: i.product_id, name: i.name, quantity: i.quantity, total: i.total })) });

export function startOfToday(tz, now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return `${ymd}T00:00:00`;
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] });

export function buildWooServer({ wc, timezone = 'UTC', now = () => new Date(), log = () => {}, version = '0.1.0' }) {
  const server = new McpServer({ name: 'urumi-woocommerce', version });
  // Every handler goes through run(): known WooCommerce failures become clean tool errors; anything unexpected is
  // logged server-side and returned as a generic message (no stack traces / internals to the model).
  const run = (fn) => async (args) => {
    try { return ok(await fn(args)); }
    catch (e) {
      if (e instanceof WcError) return fail(e.message);
      log('tool_error', e?.message); return fail('Unexpected error in WooCommerce MCP server');
    }
  };
  const pageArgs = { per_page: z.number().int().min(1).max(50).default(10).describe('Items per page (max 50)'), page: z.number().int().min(1).max(1000).default(1) };

  server.registerTool('list_products', {
    description: 'List products in the WooCommerce store, optionally filtered by search text or status.',
    inputSchema: { search: z.string().max(100).optional(), status: z.enum(['publish', 'draft', 'pending', 'private', 'any']).optional(), ...pageArgs },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, run(async ({ search, status, per_page, page }) => (await wc.request('GET', '/products', { query: { search, status, per_page, page } })).map(shapeProduct)));

  server.registerTool('create_product', {
    description: 'Create a simple product in the store. The product is published immediately unless status is "draft". Price is a decimal string such as "19.99".',
    inputSchema: { name: z.string().min(1).max(200), regular_price: z.string().regex(PRICE, 'price must look like 19 or 19.99'),
      description: z.string().max(2000).optional(), status: z.enum(['publish', 'draft']).default('publish') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, // NOT idempotent: calling twice creates two products
  }, run(async ({ name, regular_price, description, status }) => shapeProduct(await wc.request('POST', '/products', { body: { name, type: 'simple', regular_price, description, status } }))));

  server.registerTool('list_orders', {
    description: 'List orders, newest first. Use created_today=true for "orders from today" (uses the store timezone). Optional status and ISO date filters (after/before, e.g. 2026-10-20 or 2026-10-20T00:00:00).',
    inputSchema: { status: z.enum([...ORDER_STATUSES, 'any']).default('any'), created_today: z.boolean().optional(),
      after: z.string().regex(ISO).optional(), before: z.string().regex(ISO).optional(), ...pageArgs },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, run(async ({ status, created_today, after, before, per_page, page }) => {
    const a = created_today ? startOfToday(timezone, now()) : after;
    const orders = await wc.request('GET', '/orders', { query: { status, after: a, before, per_page, page, orderby: 'date', order: 'desc' } });
    return { count: orders.length, store_timezone: timezone, orders: orders.map(shapeOrder) };
  }));

  server.registerTool('get_order', {
    description: 'Get one order by its numeric ID.',
    inputSchema: { id: z.number().int().positive() }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, run(async ({ id }) => shapeOrder(await wc.request('GET', `/orders/${id}`))));

  server.registerTool('update_order_status', {
    description: 'Change the status of an order (e.g. processing -> completed, or cancelled). Returns the updated order.',
    inputSchema: { id: z.number().int().positive(), status: z.enum(ORDER_STATUSES) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }, // setting same status twice = same result
  }, run(async ({ id, status }) => shapeOrder(await wc.request('PUT', `/orders/${id}`, { body: { status } }))));

  return server;
}
