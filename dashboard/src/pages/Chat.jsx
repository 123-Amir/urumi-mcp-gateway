import { useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api.js';
import { ErrorNote, ToolId } from '../components/ui.jsx';

// What we send back to the server is ONLY the visible user/assistant text. Tool receipts are display-only: the server
// never accepts tool messages from the browser, so nothing here can forge a tool result.
function Receipt({ c }) {
  return (
    <details className={`receipt${c.isError ? ' receipt-err' : ''}`}>
      <summary>
        <ToolId name={c.name} />
        <span className={c.isError ? 'fail' : 'ok'}>{c.isError ? 'Failed' : 'Succeeded'}</span>
        <span className="ms">{c.durationMs} ms</span>
      </summary>
      <pre>{`Arguments\n${JSON.stringify(c.arguments ?? {}, null, 2)}\n\nResult\n${c.result}`}</pre>
    </details>
  );
}

export default function Chat() {
  const [info, setInfo] = useState(null);
  const [turns, setTurns] = useState([]); // { role, content, toolCalls?, error? }
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const abort = useRef(null); const end = useRef(null);

  useEffect(() => { api.chatInfo().then(setInfo).catch(() => {}); return () => abort.current?.abort(); }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [turns, busy]);

  async function send(e) {
    e?.preventDefault();
    const content = text.trim(); if (!content || busy) return;
    const history = [...turns.filter((t) => !t.error).map(({ role, content: c }) => ({ role, content: c })), { role: 'user', content }];
    setTurns((t) => [...t, { role: 'user', content }]); setText(''); setBusy(true); setError('');
    abort.current = new AbortController();
    try {
      const r = await api.chat(history.slice(-20), abort.current.signal);
      setTurns((t) => [...t, { role: 'assistant', content: r.reply || '(no reply)', toolCalls: r.toolCalls, stopped: r.stoppedEarly }]);
    } catch (err) { if (err?.name !== 'AbortError') setError(errorText(err)); }
    finally { setBusy(false); }
  }

  return (
    <div className="chat">
      <div>
        <div className="page-head" style={{ marginBottom: '.5rem' }}><div><h1>Chat</h1><p>The assistant uses the same tools and permissions as you. Every tool it calls is recorded in the audit log under your name.</p></div></div>
        {info?.mock && <p className="banner" role="status">Mock mode: replies are scripted, not written by a language model. It understands only a few phrases, such as "what orders came in today" or "create a product called Blue Mug priced 199". Set up a model provider on the server for real answers.</p>}
        {info && !info.mock && <p className="muted" style={{ marginBottom: '.5rem' }}>Model: <code>{info.model}</code></p>}
      </div>
      <div className="thread" role="log" aria-live="polite" aria-label="Conversation">
        {turns.length === 0 && <p className="empty">Ask about your store, for example "what orders came in today?"</p>}
        {turns.map((t, i) => t.role === 'user'
          ? <div key={i} className="msg msg-user"><div className="msg-body">{t.content}</div></div>
          : (
            <div key={i} className="msg msg-assistant">
              <div className="msg-who">Assistant</div>
              {t.toolCalls?.length > 0 && <div className="receipts" aria-label="Tools called">{t.toolCalls.map((c) => <Receipt key={c.id} c={c} />)}</div>}
              <div className="msg-body">{t.content}</div>
              {t.stopped && <p className="note note-info">The assistant stopped before finishing. Try a narrower request.</p>}
            </div>))}
        {busy && <p className="thinking" role="status">Working…</p>}
        <div ref={end} />
      </div>
      <div>
        <ErrorNote>{error}</ErrorNote>
        <form className="compose" onSubmit={send}>
          <textarea aria-label="Message" rows={2} value={text} maxLength={8000} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) send(e); }} placeholder="Ask a question or give an instruction" />
          {busy ? <button type="button" className="btn" onClick={() => abort.current?.abort()}>Stop</button> : <button className="btn btn-primary" disabled={!text.trim()}>Send</button>}
        </form>
      </div>
    </div>
  );
}
