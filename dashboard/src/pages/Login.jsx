import { useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, Field } from '../components/ui.jsx';

export default function Login({ onSignedIn, notice }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try { const user = await api.login(key.trim()); setKey(''); onSignedIn(user); }
    catch (err) { setError(errorText(err)); setKey(''); } // never keep a rejected key in memory/DOM
    finally { setBusy(false); }
  }
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">MCP gateway</div>
        <h1>Sign in</h1>
        <p className="muted">Paste your personal API key. Admins use the bootstrap key from the cluster secret; team members use the key an admin issued to them.</p>
        {notice && <p className="note note-info" role="status">{notice}</p>}
        <Field label="API key">
          <input type="password" name="apiKey" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck="false" autoFocus required placeholder="umk_…" />
        </Field>
        <ErrorNote>{error}</ErrorNote>
        <button className="btn btn-primary" disabled={busy || !key.trim()}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
