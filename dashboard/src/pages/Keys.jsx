import { useState } from 'react';
import { api, errorText } from '../api.js';
import { useLoad } from '../hooks.js';
import { Empty, ErrorNote, Field, Modal, OneTimeKey, when } from '../components/ui.jsx';

// Reusable list of keys for one user (self by default). Admin passes userId to manage a member's keys.
export function KeyList({ userId, who = 'you' }) {
  const { data, error, loading, reload } = useLoad(() => api.keys(userId), [userId]);
  const [label, setLabel] = useState(''); const [issued, setIssued] = useState(null);
  const [revoking, setRevoking] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  async function issue(e) {
    e.preventDefault(); setBusy(true); setErr('');
    try { setIssued(await api.createKey(label.trim(), userId)); setLabel(''); await reload(); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  async function revoke() {
    try { await api.revokeKey(revoking.id); setRevoking(null); await reload(); } catch (x) { setErr(errorText(x)); setRevoking(null); }
  }
  return (
    <div>
      <form className="actions" onSubmit={issue} style={{ alignItems: 'flex-end', marginBottom: '.75rem' }}>
        <div style={{ flex: '1 1 14rem', maxWidth: '22rem' }}><Field label="New key label" hint="For example: laptop, Cursor, CI."><input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} required /></Field></div>
        <button className="btn btn-primary" disabled={busy || !label.trim()} style={{ marginBottom: '1.7rem' }}>Generate key</button>
      </form>
      <ErrorNote>{error || err}</ErrorNote>
      {loading && !data ? <Empty>Loading keys…</Empty> : !data?.length ? <Empty>No keys yet.</Empty> : (
        <div className="tablewrap"><table>
          <thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Last used</th><th>Status</th><th /></tr></thead>
          <tbody>{data.map((k) => (
            <tr key={k.id}>
              <td>{k.label}</td><td><code>{k.prefix}…</code></td><td>{when(k.createdAt)}</td><td>{k.lastUsedAt ? when(k.lastUsedAt) : 'Never'}</td>
              <td>{k.revokedAt ? <span className="fail">Revoked</span> : <span className="ok">Active</span>}</td>
              <td>{!k.revokedAt && <button className="btn btn-quiet" onClick={() => setRevoking(k)}>Revoke</button>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {issued && <OneTimeKey apiKey={issued.key} who={who} onClose={() => setIssued(null)} />}
      {revoking && (
        <Modal title={`Revoke "${revoking.label}"?`} onClose={() => setRevoking(null)}>
          <p>Anything using this key stops working on its next request, including signed-in dashboard sessions created with it.</p>
          <div className="actions"><button className="btn btn-danger" onClick={revoke}>Revoke key</button><button className="btn" onClick={() => setRevoking(null)}>Cancel</button></div>
        </Modal>
      )}
    </div>
  );
}

export default function Keys() {
  const url = `${window.location.origin}/mcp`;
  return (
    <>
      <div className="page-head"><div><h1>API keys</h1><p>Your keys let MCP clients and scripts act as you. The full key is shown once, at creation.</p></div></div>
      <KeyList />
      <section className="connect" style={{ marginTop: '2.25rem' }}>
        <h2>Connect an MCP client</h2>
        <p>Point Claude Code, Cursor or MCP Inspector at the gateway. You do not configure any individual server; every tool you are allowed to use appears automatically.</p>
        <dl>
          <dt>Transport</dt><dd>Streamable HTTP</dd>
          <dt>URL</dt><dd><code>{url}</code></dd>
          <dt>Header</dt><dd><code>Authorization: Bearer &lt;your key&gt;</code></dd>
        </dl>
        <p className="muted">Exact setup steps differ per client, so check your client's documentation for adding a remote HTTP MCP server with a custom header.</p>
      </section>
    </>
  );
}
