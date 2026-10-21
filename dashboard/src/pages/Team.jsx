import { useState } from 'react';
import { api, errorText } from '../api.js';
import { useLoad } from '../hooks.js';
import { Empty, ErrorNote, Field, Modal, OneTimeKey, when } from '../components/ui.jsx';
import { KeyList } from './Keys.jsx';

export default function Team({ user }) {
  const { data, error, loading, reload } = useLoad(api.users);
  const [inviting, setInviting] = useState(false); const [issued, setIssued] = useState(null);
  const [f, setF] = useState({ email: '', name: '', role: 'member' }); const [formErr, setFormErr] = useState(''); const [busy, setBusy] = useState(false);
  const [openKeys, setOpenKeys] = useState(null); const [actionErr, setActionErr] = useState('');

  async function invite(e) {
    e.preventDefault(); setBusy(true); setFormErr('');
    try { const r = await api.createUser(f); setInviting(false); setF({ email: '', name: '', role: 'member' }); setIssued({ key: r.apiKey.key, who: r.user.email }); await reload(); }
    catch (x) { setFormErr(errorText(x)); } finally { setBusy(false); }
  }
  const patch = async (u, body) => { setActionErr(''); try { await api.updateUser(u.id, body); await reload(); } catch (x) { setActionErr(errorText(x)); } };

  return (
    <>
      <div className="page-head">
        <div><h1>Team</h1><p>Admins manage servers and members. Members use tools through the chat and their own key.</p></div>
        <button className="btn btn-primary" onClick={() => setInviting(true)}>Invite member</button>
      </div>
      <ErrorNote>{error || actionErr}</ErrorNote>
      {loading && !data ? <Empty>Loading members…</Empty> : (
        <ul className="ledger" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data?.map((u) => (
            <li className="row" key={u.id}>
              <div className="row-main">
                <div className="row-title"><strong>{u.name}</strong>{u.disabled && <span className="fail">Disabled</span>}{u.id === user.id && <span className="muted">You</span>}</div>
                <div className="row-meta"><span>{u.email}</span><span>Joined {when(u.createdAt)}</span></div>
              </div>
              <div className="row-actions" style={{ alignItems: 'center' }}>
                <select aria-label={`Role for ${u.email}`} value={u.role} onChange={(e) => patch(u, { role: e.target.value })} style={{ width: 'auto' }}>
                  <option value="member">Member</option><option value="admin">Admin</option>
                </select>
                <button className="btn btn-quiet" onClick={() => patch(u, { disabled: !u.disabled })}>{u.disabled ? 'Enable' : 'Disable'}</button>
                <button className="btn btn-quiet" aria-expanded={openKeys === u.id} onClick={() => setOpenKeys(openKeys === u.id ? null : u.id)}>Keys</button>
              </div>
              {openKeys === u.id && <div className="row-detail"><KeyList userId={u.id} who={u.email} /></div>}
            </li>))}
        </ul>
      )}
      {inviting && (
        <Modal title="Invite a member" onClose={() => setInviting(false)}>
          <form onSubmit={invite}>
            <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} /></Field>
            <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
            <Field label="Role" hint="Members can use tools. Admins can also manage servers and the team."><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="member">Member</option><option value="admin">Admin</option></select></Field>
            <p className="muted">You will get their first API key once. Send it to them yourself; the gateway does not send email.</p>
            <ErrorNote>{formErr}</ErrorNote>
            <div className="actions"><button className="btn btn-primary" disabled={busy}>{busy ? 'Inviting…' : 'Invite member'}</button><button type="button" className="btn" onClick={() => setInviting(false)}>Cancel</button></div>
          </form>
        </Modal>
      )}
      {issued && <OneTimeKey apiKey={issued.key} who={issued.who} onClose={() => setIssued(null)} />}
    </>
  );
}
