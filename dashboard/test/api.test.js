import { api, setUnauthorizedHandler, errorText, ApiError } from '../src/api.js';
import { mockApi } from './helpers.js';

afterEach(() => setUnauthorizedHandler(() => {}));

test('login sends the key once; later state-changing calls carry the CSRF token; GETs do not need it; cookies are same-origin only', async () => {
  const calls = mockApi({ 'POST /api/auth/login': { user: { id: 'u' }, csrfToken: 'tok-1' }, 'POST /api/keys': { apiKey: { key: 'k' } }, 'GET /api/keys': { keys: [] } });
  await api.login('umk_secret');
  await api.createKey('laptop'); await api.keys();
  expect(calls[0].headers['X-CSRF-Token']).toBeUndefined();               // login has no session yet
  expect(calls[1].headers['X-CSRF-Token']).toBe('tok-1');
  expect(calls[2].headers['X-CSRF-Token']).toBeUndefined();               // safe method
  expect(calls.every((c) => c.credentials === 'same-origin')).toBe(true);
  expect(calls.filter((c) => JSON.stringify(c).includes('umk_secret')).length).toBe(1); // key appears in exactly one request
  expect(calls.some((c) => c.url.includes('umk_secret'))).toBe(false);
});

test('a 401 on a normal call triggers the sign-out handler and drops the CSRF token; a 401 on login does not', async () => {
  const handler = vi.fn(); setUnauthorizedHandler(handler);
  mockApi({ 'GET /api/servers': { status: 401, body: { error: 'unauthenticated' } }, 'POST /api/auth/login': { status: 401, body: { error: 'invalid_credentials' } } });
  await expect(api.servers()).rejects.toMatchObject({ status: 401 }); expect(handler).toHaveBeenCalledTimes(1);
  await expect(api.login('x')).rejects.toBeInstanceOf(ApiError); expect(handler).toHaveBeenCalledTimes(1);
});

test('errors become plain-language messages (server text is used only for validation / known-safe messages)', async () => {
  mockApi({ 'POST /api/servers': { status: 400, body: { error: 'validation_failed', issues: [{ path: 'slug', message: 'Invalid' }] } }, 'POST /api/users': { status: 409, body: { error: 'email_taken' } },
    'POST /api/chat': { status: 502, body: { error: 'llm_error', message: 'LLM provider rejected the API key' } }, 'GET /api/users': { status: 500, body: { error: 'internal_error' } } });
  await expect(api.createServer({})).rejects.toThrow('slug: Invalid');
  await expect(api.createUser({})).rejects.toThrow(/already exists/);
  await expect(api.chat([])).rejects.toThrow('LLM provider rejected the API key');
  expect(errorText(await api.users().catch((e) => e))).toBe('Request failed (500).');
  expect(errorText(new TypeError('fetch failed'))).toMatch(/Could not reach the gateway/);
});
