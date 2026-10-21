import { useState } from 'react';
import { api } from '../api.js';
import { useLoad } from '../hooks.js';
import { Empty, ErrorNote, ToolId, when } from '../components/ui.jsx';

const PAGE = 50;
export default function Audit({ user }) {
  const admin = user.role === 'admin';
  const [offset, setOffset] = useState(0); const [userId, setUserId] = useState('');
  const { data, error, loading, reload } = useLoad(() => api.audit({ limit: PAGE, offset, userId: admin ? userId : undefined }), [offset, userId]);
  const users = useLoad(() => (admin ? api.users() : Promise.resolve([])), [admin]);
  return (
    <>
      <div className="page-head">
        <div><h1>Audit log</h1><p>{admin ? 'Every tool call made by anyone, from the chat or an MCP client.' : 'Every tool call made with your account.'} Arguments and results are not stored.</p></div>
        <div className="actions" style={{ marginTop: 0 }}>
          {admin && <select aria-label="Filter by member" value={userId} onChange={(e) => { setOffset(0); setUserId(e.target.value); }} style={{ width: 'auto' }}>
            <option value="">All members</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
          </select>}
          <button className="btn" onClick={reload}>Refresh</button>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {loading && !data ? <Empty>Loading audit log…</Empty> : !data?.length ? <Empty>No tool calls recorded yet.</Empty> : (
        <div className="tablewrap"><table>
          <thead><tr><th>Time</th>{admin && <th>Member</th>}<th>Via</th><th>Tool</th><th className="num">Duration</th><th>Outcome</th></tr></thead>
          <tbody>{data.map((e) => (
            <tr key={e.id}>
              <td>{when(e.timestamp)}</td>{admin && <td>{e.userEmail}</td>}
              <td>{e.source === 'chat' ? 'Chat' : 'MCP client'}</td>
              <td>{e.server ? <ToolId name={`${e.server}__${e.tool}`} /> : <code>{e.tool ?? 'unknown'}</code>}</td>
              <td className="num">{e.durationMs ?? 0} ms</td>
              <td>{e.success ? <span className="ok">Succeeded</span> : <><span className="fail">Failed</span>{e.errorSummary && <div className="muted">{e.errorSummary}</div>}</>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      <div className="actions">
        <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</button>
        <button className="btn" disabled={!data || data.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</button>
      </div>
    </>
  );
}
