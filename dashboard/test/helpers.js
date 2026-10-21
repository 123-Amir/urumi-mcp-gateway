import { vi } from 'vitest';

// Tiny fetch router: routes = { 'GET /api/servers': (req) => ({ status, body }) | body }.  Records every call.
export function mockApi(routes) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase(); const path = String(url).split('?')[0];
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, url: String(url), body, headers: init.headers ?? {}, credentials: init.credentials });
    const h = routes[`${method} ${path}`];
    if (!h) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const out = typeof h === 'function' ? await h({ body, url: String(url) }) : h;
    const status = out?.status ?? 200; const data = out && 'body' in out ? out.body : out;
    return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}
export const ADMIN = { id: 'u1', email: 'admin@x.com', name: 'Admin', role: 'admin', disabled: false, createdAt: '2026-10-01T00:00:00Z' };
export const MEMBER = { id: 'u2', email: 'bob@x.com', name: 'Bob', role: 'member', disabled: false, createdAt: '2026-10-02T00:00:00Z' };
export const session = (user) => ({ 'GET /api/auth/me': { user, csrfToken: 'csrf-123', via: 'session' } });
export const SERVERS = [
  { id: 's1', slug: 'woo', name: 'WooCommerce', url: 'http://woo-mcp:3000/mcp', enabled: true, authType: 'bearer', authHeaderName: null, hasCredential: true, status: 'connected', statusDetail: null, lastCheckedAt: '2026-10-21T10:00:00Z',
    tools: [{ name: 'list_orders', namespacedName: 'woo__list_orders', description: '[woo] List orders' }, { name: 'create_product', namespacedName: 'woo__create_product', description: '[woo] Create product' }] },
  { id: 's2', slug: 'notes', name: 'Notes', url: 'http://notes:3000/mcp', enabled: true, authType: 'none', authHeaderName: null, hasCredential: false, status: 'unreachable', statusDetail: 'connection: ECONNREFUSED', lastCheckedAt: null, tools: [] },
  { id: 's3', slug: 'utils', name: 'Utilities', url: 'http://utils:3000/mcp', enabled: false, authType: 'none', authHeaderName: null, hasCredential: false, status: 'disabled', statusDetail: null, lastCheckedAt: null, tools: [] },
];
