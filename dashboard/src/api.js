// The ONLY module that talks to the gateway. Security-relevant rules live here:
//  * the API key is sent once (login) and then forgotten; the browser keeps only the HttpOnly session cookie (JS cannot read it)
//  * the CSRF token is kept in a module variable (memory), NOT in localStorage/sessionStorage/cookies; a page reload re-fetches it from /api/auth/me
//  * every state-changing request carries X-CSRF-Token; credentials are same-origin only
let csrf = null;
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, code, message) { super(message ?? ''); this.status = status; this.code = code; } // '' not null: Error(null).message is the string "null"
}

const FRIENDLY = {
  invalid_credentials: "That key isn't valid, or it has been revoked.",
  too_many_attempts: 'Too many failed attempts. Wait a minute and try again.',
  unauthenticated: 'Your session has ended. Sign in again.',
  forbidden: "You don't have permission to do that.",
  csrf_failed: 'Your session is out of date. Reload the page and try again.',
  bad_origin: 'This page is not served from an allowed origin.',
  slug_taken: 'A server with that identifier already exists.',
  email_taken: 'A member with that email already exists.',
  last_admin: 'You cannot remove or demote the last admin.',
  too_many_keys: 'This member already has 10 active keys. Revoke one first.',
  user_disabled: 'This member is disabled.',
  rate_limited: 'You are sending messages too fast. Wait a moment.',
  chat_timeout: 'The assistant took too long to answer.',
  session_ended: 'Your access was revoked while the assistant was working.',
  payload_too_large: 'That request is too large.',
  not_found: 'That item no longer exists.',
};

export function errorText(e) {
  if (!(e instanceof ApiError)) return 'Could not reach the gateway. Check your connection.';
  return e.message || FRIENDLY[e.code] || `Request failed (${e.status}).`;
}

async function request(method, path, body, { signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(path, { method, headers, credentials: 'same-origin', signal, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') { csrf = null; onUnauthorized(); }
    let message = null;
    if (data?.error === 'validation_failed' && Array.isArray(data.issues)) message = data.issues.map((i) => `${i.path || 'request'}: ${i.message}`).join('; ');
    else if (data?.error === 'bad_request' || data?.error === 'llm_error') message = data.message ?? null; // server-written, already safe text
    throw new ApiError(res.status, data?.error ?? 'error', message ?? FRIENDLY[data?.error] ?? null);
  }
  return data;
}

const q = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };

export const api = {
  async login(apiKey) { const d = await request('POST', '/api/auth/login', { apiKey }); csrf = d.csrfToken; return d.user; },
  async me() { const d = await request('GET', '/api/auth/me'); csrf = d.csrfToken; return d.user; },
  async logout() { try { await request('POST', '/api/auth/logout'); } finally { csrf = null; } },
  tools: () => request('GET', '/api/tools').then((d) => d.tools),
  servers: () => request('GET', '/api/servers').then((d) => d.servers),
  createServer: (b) => request('POST', '/api/servers', b).then((d) => d.server),
  updateServer: (id, b) => request('PATCH', `/api/servers/${id}`, b).then((d) => d.server),
  refreshServer: (id) => request('POST', `/api/servers/${id}/refresh`).then((d) => d.server),
  deleteServer: (id) => request('DELETE', `/api/servers/${id}`),
  users: () => request('GET', '/api/users').then((d) => d.users),
  createUser: (b) => request('POST', '/api/users', b),
  updateUser: (id, b) => request('PATCH', `/api/users/${id}`, b).then((d) => d.user),
  keys: (userId) => request('GET', `/api/keys${q({ userId })}`).then((d) => d.keys),
  createKey: (label, userId) => request('POST', '/api/keys', { label, ...(userId ? { userId } : {}) }).then((d) => d.apiKey),
  revokeKey: (id) => request('DELETE', `/api/keys/${id}`),
  audit: (o = {}) => request('GET', `/api/audit${q(o)}`).then((d) => d.entries),
  chatInfo: () => request('GET', '/api/chat/info'),
  chat: (messages, signal) => request('POST', '/api/chat', { messages }, { signal }),
};
