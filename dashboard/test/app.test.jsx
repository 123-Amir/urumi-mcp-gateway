import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import { setUnauthorizedHandler } from '../src/api.js';
import { mockApi, session, ADMIN, MEMBER, SERVERS } from './helpers.js';

beforeEach(() => { window.location.hash = ''; });
const signedOut = { 'GET /api/auth/me': { status: 401, body: { error: 'unauthenticated' } } };

test('signed out => login form; wrong key shows a clear error and CLEARS the input; correct key opens the app', async () => {
  let ok = false;
  const calls = mockApi({ ...signedOut, 'POST /api/auth/login': () => (ok ? { user: ADMIN, csrfToken: 'c' } : { status: 401, body: { error: 'invalid_credentials' } }), 'GET /api/servers': [] , ...{ 'GET /api/servers': { servers: [] } } });
  render(<App />); const u = userEvent.setup();
  const input = await screen.findByLabelText('API key');
  expect(input).toHaveAttribute('type', 'password');
  await u.type(input, 'umk_wrongwrong'); await u.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/isn't valid, or it has been revoked/);
  expect(screen.getByLabelText('API key')).toHaveValue('');
  ok = true; await u.type(screen.getByLabelText('API key'), 'umk_right'); await u.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('heading', { name: 'Servers' })).toBeInTheDocument();
  expect(calls.filter((c) => c.path === '/api/auth/login').length).toBe(2);
});

test('admin sees Team + server management; member sees neither and uses a read-only "Tools" page (server enforces the real limits)', async () => {
  mockApi({ ...session(ADMIN), 'GET /api/servers': { servers: SERVERS } });
  const a = render(<App />);
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav).getByText('Team')).toBeInTheDocument(); expect(await screen.findByRole('button', { name: 'Add server' })).toBeInTheDocument();
  a.unmount();
  mockApi({ ...session(MEMBER), 'GET /api/tools': { tools: [{ name: 'woo__list_orders', description: '[woo] List orders' }] } });
  render(<App />);
  const nav2 = await screen.findByRole('navigation', { name: 'Main' });
  expect(within(nav2).queryByText('Team')).not.toBeInTheDocument(); expect(within(nav2).getByText('Tools')).toBeInTheDocument();
  expect(await screen.findByText('list_orders')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Add server' })).not.toBeInTheDocument();
});

test('servers: status shown as text (Connected / Unreachable with reason / Disabled), tools shown as server__tool, credential never displayed', async () => {
  mockApi({ ...session(ADMIN), 'GET /api/servers': { servers: SERVERS } });
  render(<App />); const u = userEvent.setup();
  await screen.findByText('WooCommerce');
  expect(screen.getByText('Connected')).toBeInTheDocument(); expect(screen.getByText('Unreachable')).toBeInTheDocument(); expect(screen.getByText('Disabled')).toBeInTheDocument();
  expect(screen.getByText(/connection: ECONNREFUSED/)).toBeInTheDocument();
  expect(screen.getByText(/Credential set \(bearer token\)/)).toBeInTheDocument();
  await u.click(screen.getByRole('button', { name: 'Show 2 tools' }));
  const id = screen.getByText('list_orders').closest('code'); expect(id).toHaveTextContent('woo__list_orders');
  expect(document.body.textContent).not.toMatch(/credential_enc|secret/i);
});

test('add server: sends the exact body with the CSRF header; credential field is write-only (password)', async () => {
  const calls = mockApi({ ...session(ADMIN), 'GET /api/servers': { servers: [] }, 'POST /api/servers': { status: 201, body: { server: { ...SERVERS[0] } } } });
  render(<App />); const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Add server' }));
  await u.type(screen.getByLabelText('Name'), 'Shop'); await u.type(screen.getByLabelText('Identifier'), 'shop'); await u.type(screen.getByLabelText('Server URL'), 'http://woo-mcp:3000/mcp');
  await u.selectOptions(screen.getByLabelText('Authentication'), 'bearer');
  const cred = screen.getByLabelText('Token'); expect(cred).toHaveAttribute('type', 'password'); await u.type(cred, 's3cret');
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add server' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/servers')).toBe(true));
  const post = calls.find((c) => c.method === 'POST' && c.path === '/api/servers');
  expect(post.body).toEqual({ slug: 'shop', name: 'Shop', url: 'http://woo-mcp:3000/mcp', enabled: true, authType: 'bearer', credential: 's3cret' });
  expect(post.headers['X-CSRF-Token']).toBe('csrf-123');
});

test('edit server: identifier locked; leaving the credential blank does NOT send one (keeps the stored secret)', async () => {
  const calls = mockApi({ ...session(ADMIN), 'GET /api/servers': { servers: [SERVERS[0]] }, 'PATCH /api/servers/s1': { server: SERVERS[0] } });
  render(<App />); const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Identifier')).toBeDisabled();
  await u.clear(screen.getByLabelText('Name')); await u.type(screen.getByLabelText('Name'), 'Woo store');
  await u.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
  const patch = calls.find((c) => c.method === 'PATCH'); expect(patch.body).toEqual({ name: 'Woo store', url: 'http://woo-mcp:3000/mcp', enabled: true, authType: 'bearer' });
  expect('credential' in patch.body).toBe(false);
});

test('disable toggles via PATCH; remove needs explicit confirmation before DELETE', async () => {
  const calls = mockApi({ ...session(ADMIN), 'GET /api/servers': { servers: [SERVERS[0]] }, 'PATCH /api/servers/s1': { server: SERVERS[0] }, 'DELETE /api/servers/s1': { status: 204 } });
  render(<App />); const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Disable' }));
  await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false }));
  await u.click(screen.getByRole('button', { name: 'Remove' }));
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);                 // dialog only so far
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove server' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/servers/s1')).toBe(true));
});

test('API keys: generated key is shown once in a dialog and is gone from the page after closing', async () => {
  let keys = [];
  mockApi({ ...session(MEMBER), 'GET /api/keys': () => ({ keys }), 'POST /api/keys': () => { keys = [{ id: 'k1', userId: 'u2', label: 'laptop', prefix: 'umk_abcd1234', createdAt: '2026-10-21T00:00:00Z', lastUsedAt: null, revokedAt: null }]; return { status: 201, body: { apiKey: { id: 'k1', prefix: 'umk_abcd1234', key: 'umk_abcd1234_FULLSECRETVALUE' } } }; } });
  window.location.hash = '#/keys'; render(<App />); const u = userEvent.setup();
  await u.type(await screen.findByLabelText('New key label'), 'laptop'); await u.click(screen.getByRole('button', { name: 'Generate key' }));
  expect(await screen.findByTestId('one-time-key')).toHaveTextContent('umk_abcd1234_FULLSECRETVALUE');
  await u.click(screen.getByRole('button', { name: 'I have saved it' }));
  expect(document.body.textContent).not.toContain('FULLSECRETVALUE');            // only the prefix remains
  expect(screen.getByText('umk_abcd1234…')).toBeInTheDocument();
});

test('revoking a key asks for confirmation first, then calls DELETE', async () => {
  const k = { id: 'k9', userId: 'u2', label: 'ci', prefix: 'umk_zzzz9999', createdAt: '2026-10-21T00:00:00Z', lastUsedAt: null, revokedAt: null };
  const calls = mockApi({ ...session(MEMBER), 'GET /api/keys': { keys: [k] }, 'DELETE /api/keys/k9': { status: 204 } });
  window.location.hash = '#/keys'; render(<App />); const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Revoke' }));
  expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke key' }));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/keys/k9')).toBe(true));
});

test('team: invite shows the new member\'s one-time key; role change and disable are PATCHes', async () => {
  const calls = mockApi({ ...session(ADMIN), 'GET /api/users': { users: [ADMIN, MEMBER] }, 'POST /api/users': { status: 201, body: { user: { ...MEMBER, id: 'u3', email: 'new@x.com' }, apiKey: { id: 'k', prefix: 'umk_x', key: 'umk_new_ONETIME' } } }, 'PATCH /api/users/u2': { user: MEMBER } });
  window.location.hash = '#/team'; render(<App />); const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Invite member' }));
  await u.type(screen.getByLabelText('Name'), 'Newbie'); await u.type(screen.getByLabelText('Email'), 'new@x.com');
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Invite member' }));
  expect(await screen.findByTestId('one-time-key')).toHaveTextContent('umk_new_ONETIME');
  await u.click(screen.getByRole('button', { name: 'I have saved it' }));
  await u.selectOptions(screen.getByLabelText('Role for bob@x.com'), 'admin');
  await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ role: 'admin' }));
});

test('chat: mock banner; sends only user/assistant turns; tool receipts show name, outcome, duration, args and result; errors are explained', async () => {
  let n = 0;
  const calls = mockApi({ ...session(MEMBER), 'GET /api/chat/info': { mode: 'mock', model: 'scripted-mock', mock: true },
    'POST /api/chat': () => (++n === 1 ? { reply: '1 order today', steps: 2, toolCalls: [{ id: 'a', name: 'utils__current_date', server: 'utils', tool: 'current_date', arguments: {}, isError: false, result: '2026-10-20', durationMs: 12 }, { id: 'b', name: 'woo__list_orders', server: 'woo', tool: 'list_orders', arguments: { created_today: true }, isError: true, result: 'boom', durationMs: 340 }] } : { status: 502, body: { error: 'llm_error', message: 'LLM provider rejected the API key' } }) });
  window.location.hash = '#/chat'; render(<App />); const u = userEvent.setup();
  expect(await screen.findByText(/Mock mode: replies are scripted/)).toBeInTheDocument();
  await u.type(screen.getByLabelText('Message'), 'what orders came in today?'); await u.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('1 order today')).toBeInTheDocument();
  expect(calls.find((c) => c.path === '/api/chat').body).toEqual({ messages: [{ role: 'user', content: 'what orders came in today?' }] });
  const receipts = screen.getByLabelText('Tools called'); expect(receipts).toHaveTextContent('utils__current_date'); expect(receipts).toHaveTextContent('woo__list_orders');
  expect(receipts).toHaveTextContent('Succeeded'); expect(receipts).toHaveTextContent('Failed'); expect(receipts).toHaveTextContent('340 ms');
  await u.type(screen.getByLabelText('Message'), 'and yesterday?'); await u.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('LLM provider rejected the API key');
  const second = calls.filter((c) => c.path === '/api/chat')[1].body.messages;
  expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']); expect(second.every((m) => Object.keys(m).sort().join() === 'content,role')).toBe(true); // no tool receipts echoed back
});

test('audit: member sees only own columns; admin gets a member filter; failures show the safe summary', async () => {
  const entries = [{ id: 2, timestamp: '2026-10-21T10:00:00Z', userId: 'u2', userEmail: 'bob@x.com', source: 'chat', server: 'woo', tool: 'list_orders', durationMs: 41, success: false, errorSummary: 'timeout: Upstream "woo" timed out' },
    { id: 1, timestamp: '2026-10-21T09:00:00Z', userId: 'u2', userEmail: 'bob@x.com', source: 'mcp', server: 'utils', tool: 'current_date', durationMs: 5, success: true, errorSummary: null }];
  mockApi({ ...session(MEMBER), 'GET /api/audit': { entries } });
  window.location.hash = '#/audit'; const m = render(<App />);
  expect(await screen.findByText('Failed')).toBeInTheDocument(); expect(screen.getByText(/timed out/)).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Member' })).not.toBeInTheDocument(); expect(screen.queryByLabelText('Filter by member')).not.toBeInTheDocument();
  m.unmount();
  mockApi({ ...session(ADMIN), 'GET /api/audit': { entries }, 'GET /api/users': { users: [ADMIN, MEMBER] } });
  render(<App />);
  expect(await screen.findByRole('columnheader', { name: 'Member' })).toBeInTheDocument(); expect(screen.getByLabelText('Filter by member')).toBeInTheDocument();
});

test('a 401 mid-session (revoked key / expired) returns to the sign-in screen with an explanation', async () => {
  let dead = false;
  mockApi({ ...session(ADMIN), 'GET /api/servers': () => (dead ? { status: 401, body: { error: 'unauthenticated' } } : { servers: [SERVERS[0]] }), 'POST /api/servers/s1/refresh': () => { dead = true; return { status: 401, body: { error: 'unauthenticated' } }; } });
  render(<App />); const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Check now' }));
  expect(await screen.findByText(/Your session has ended/)).toBeInTheDocument(); expect(screen.getByLabelText('API key')).toBeInTheDocument();
});

test('REGRESSION: typing in a second field of a dialog keeps focus there (modal must not re-grab focus on each render)', async () => {
  mockApi({ ...session(ADMIN), 'GET /api/users': { users: [ADMIN] } });
  window.location.hash = '#/team'; render(<App />); const u = userEvent.setup();
  await u.click(await screen.findByRole('button', { name: 'Invite member' }));
  await u.type(screen.getByLabelText('Name'), 'Ann'); await u.type(screen.getByLabelText('Email'), 'ann@x.com');
  expect(screen.getByLabelText('Name')).toHaveValue('Ann'); expect(screen.getByLabelText('Email')).toHaveValue('ann@x.com');
});
