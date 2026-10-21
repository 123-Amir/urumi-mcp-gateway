import { useState } from 'react';
import { api, errorText } from '../api.js';
import { useLoad } from '../hooks.js';
import { Modal, Field, ErrorNote, Empty, Status, ToolId, when } from '../components/ui.jsx';

const BLANK = { name: '', slug: '', url: '', authType: 'none', authHeaderName: '', credential: '', enabled: true };

function ServerForm({ server, onClose, onSaved }) {
  const editing = !!server;
  const [f, setF] = useState(editing ? { ...BLANK, name: server.name, slug: server.slug, url: server.url, authType: server.authType, authHeaderName: server.authHeaderName ?? '', enabled: server.enabled } : BLANK);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      let saved;
      if (editing) {
        const body = { name: f.name, url: f.url, enabled: f.enabled, authType: f.authType };
        if (f.authType === 'header') body.authHeaderName = f.authHeaderName;
        if (f.authType !== 'none' && f.credential) body.credential = f.credential; // blank = keep the stored credential
        saved = await api.updateServer(server.id, body);
      } else {
        const body = { slug: f.slug, name: f.name, url: f.url, enabled: f.enabled, authType: f.authType };
        if (f.authType === 'header') body.authHeaderName = f.authHeaderName;
        if (f.authType !== 'none') body.credential = f.credential;
        saved = await api.createServer(body);
      }
      onSaved(saved);
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }
  const needsCred = f.authType !== 'none';
  return (
    <Modal title={editing ? `Edit ${server.name}` : 'Add MCP server'} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name"><input value={f.name} onChange={set('name')} required maxLength={80} /></Field>
        <Field label="Identifier" hint={editing ? "Tools are exposed as identifier__tool. The identifier can't change after creation because clients depend on it." : 'Lowercase letters, digits and hyphens. Tools will be exposed as identifier__tool, for example shop__list_orders.'}>
          <input value={f.slug} onChange={set('slug')} required disabled={editing} pattern="[a-z][a-z0-9\-]{1,29}" />
        </Field>
        <Field label="Server URL" hint="The Streamable HTTP endpoint, for example http://woo-mcp:3000/mcp. Internal addresses must be on the gateway's allowlist.">
          <input type="url" value={f.url} onChange={set('url')} required />
        </Field>
        <Field label="Authentication">
          <select value={f.authType} onChange={set('authType')}>
            <option value="none">None</option><option value="bearer">Bearer token</option><option value="header">Custom header</option>
          </select>
        </Field>
        {f.authType === 'header' && <Field label="Header name"><input value={f.authHeaderName} onChange={set('authHeaderName')} required placeholder="X-Api-Key" /></Field>}
        {needsCred && (
          <Field label={f.authType === 'bearer' ? 'Token' : 'Header value'} hint={editing && server.hasCredential ? 'A credential is stored. Leave blank to keep it, or type a new one to replace it. Stored credentials are never shown.' : 'Stored encrypted on the server. It is never sent to browsers or MCP clients.'}>
            <input type="password" value={f.credential} onChange={set('credential')} autoComplete="new-password" required={!editing || !server.hasCredential} />
          </Field>
        )}
        <label className="check"><input type="checkbox" checked={f.enabled} onChange={set('enabled')} /> Enabled</label>
        <ErrorNote>{error}</ErrorNote>
        <div className="actions">
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Add server'}</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

function ServerRow({ s, onEdit, onChanged, onRemove, onError }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false);
  const act = async (fn) => { setBusy(true); try { await fn(); await onChanged(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); } };
  return (
    <li className="row">
      <div className="row-main">
        <div className="row-title"><strong>{s.name}</strong><Status status={s.status} /></div>
        <div className="row-meta">
          <span>Identifier <code>{s.slug}</code></span>
          <span>URL <code>{s.url}</code></span>
          <span>{s.authType === 'none' ? 'No credential' : s.hasCredential ? `Credential set (${s.authType === 'bearer' ? 'bearer token' : s.authHeaderName})` : 'Credential missing'}</span>
          {s.lastCheckedAt && <span>Checked {when(s.lastCheckedAt)}</span>}
        </div>
        {s.status === 'unreachable' && s.statusDetail && <p className="note note-bad" role="status">Why: {s.statusDetail}</p>}
      </div>
      <div className="row-actions">
        <button className="btn btn-quiet" disabled={busy || !s.enabled} onClick={() => act(() => api.refreshServer(s.id))}>Check now</button>
        <button className="btn btn-quiet" onClick={() => onEdit(s)}>Edit</button>
        <button className="btn btn-quiet" disabled={busy} onClick={() => act(() => api.updateServer(s.id, { enabled: !s.enabled }))}>{s.enabled ? 'Disable' : 'Enable'}</button>
        <button className="btn btn-quiet" onClick={() => onRemove(s)}>Remove</button>
      </div>
      <div className="row-detail">
        <button className="btn btn-quiet" style={{ paddingLeft: 0 }} aria-expanded={open} onClick={() => setOpen(!open)} disabled={!s.tools.length}>
          {s.tools.length ? `${open ? 'Hide' : 'Show'} ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : s.enabled ? 'No tools available' : 'Tools hidden while disabled'}
        </button>
        {open && (
          <div className="toollist">
            {s.tools.map((t) => <div className="tool" key={t.namespacedName}><ToolId name={t.namespacedName} /><p>{t.description}</p></div>)}
          </div>
        )}
      </div>
    </li>
  );
}

function AdminServers() {
  const { data, error, loading, reload } = useLoad(api.servers);
  const [form, setForm] = useState(null); // null | 'new' | server
  const [removing, setRemoving] = useState(null); const [actionError, setActionError] = useState('');
  async function confirmRemove() {
    try { await api.deleteServer(removing.id); setRemoving(null); await reload(); } catch (e) { setActionError(errorText(e)); setRemoving(null); }
  }
  return (
    <>
      <div className="page-head">
        <div><h1>Servers</h1><p>Every enabled, reachable server's tools are exposed to the whole team through one gateway endpoint.</p></div>
        <button className="btn btn-primary" onClick={() => setForm('new')}>Add server</button>
      </div>
      <ErrorNote>{error || actionError}</ErrorNote>
      {loading && !data ? <Empty>Loading servers…</Empty> : data?.length === 0 ? <Empty>No servers yet. Add one to expose its tools to the team.</Empty> : (
        <ul className="ledger" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data?.map((s) => <ServerRow key={s.id} s={s} onEdit={setForm} onChanged={reload} onRemove={setRemoving} onError={setActionError} />)}
        </ul>
      )}
      {form && <ServerForm server={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <p>Its tools disappear for everyone immediately, in the dashboard chat and in connected MCP clients. Past audit entries are kept.</p>
          <div className="actions"><button className="btn btn-danger" onClick={confirmRemove}>Remove server</button><button className="btn" onClick={() => setRemoving(null)}>Cancel</button></div>
        </Modal>
      )}
    </>
  );
}

// Members cannot list servers (admin-only API); they see the tools THEY may use, grouped by server.
function MemberTools() {
  const { data, error, loading } = useLoad(api.tools);
  const groups = {};
  for (const t of data ?? []) { const s = t.name.split('__')[0]; (groups[s] ??= []).push(t); }
  return (
    <>
      <div className="page-head"><div><h1>Tools</h1><p>These are the tools you can use in the chat and from any MCP client connected with your key. An admin manages the servers behind them.</p></div></div>
      <ErrorNote>{error}</ErrorNote>
      {loading ? <Empty>Loading tools…</Empty> : !data?.length ? <Empty>No tools are available right now. Ask an admin whether a server is disabled or unreachable.</Empty> : (
        <div className="ledger">{Object.entries(groups).map(([server, tools]) => (
          <section className="row" key={server} style={{ gridTemplateColumns: '1fr' }}>
            <h2>{server}</h2>
            <div className="toollist">{tools.map((t) => <div className="tool" key={t.name}><ToolId name={t.name} /><p>{t.description}</p></div>)}</div>
          </section>
        ))}</div>
      )}
    </>
  );
}

export default function Servers({ user }) { return user.role === 'admin' ? <AdminServers /> : <MemberTools />; }
