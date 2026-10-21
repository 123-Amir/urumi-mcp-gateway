import { cloneElement, useEffect, useId, useRef, useState } from 'react';

// "woo__list_orders" is drawn as  woo | __ | list_orders  so people SEE the <server>__<tool> naming rule.
export function ToolId({ name }) {
  const i = name.indexOf('__');
  if (i < 1) return <code className="toolid">{name}</code>;
  return <code className="toolid"><span className="toolid-server">{name.slice(0, i)}</span><span className="toolid-sep">__</span>{name.slice(i + 2)}</code>;
}

// Status is never colour-only: each state has its own shape AND a text label.
const LAMP = { connected: ['Connected', 'circle'], unreachable: ['Unreachable', 'tri'], disabled: ['Disabled', 'ring'], connecting: ['Connecting', 'ring'] };
export function Status({ status }) {
  const [label, shape] = LAMP[status] ?? ['Unknown', 'ring'];
  return (
    <span className={`status status-${status}`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        {shape === 'circle' && <circle cx="6" cy="6" r="5" fill="currentColor" />}
        {shape === 'tri' && <path d="M6 1 11.2 10.5H.8Z" fill="currentColor" />}
        {shape === 'ring' && <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.8" />}
      </svg>
      {label}
    </span>
  );
}

export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  // onClose is usually an inline arrow (new identity every render). If it were an effect dependency, the effect would re-run on
  // every keystroke and steal focus back to the first field. So: remember the latest callback in a ref, run the effect once.
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('input:not([disabled]), select, button')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// The hint is linked with aria-describedby (read AFTER the field name), not nested in the <label>, so a screen reader announces
// "Identifier, edit text" followed by the hint instead of reading the whole paragraph as the field's name.
export function Field({ label, hint, children }) {
  const id = useId(); const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {cloneElement(children, { id, ...(hint ? { 'aria-describedby': hintId } : {}) })}
      {hint && <span className="field-hint" id={hintId}>{hint}</span>}
    </div>
  );
}

export const ErrorNote = ({ children }) => (children ? <p className="note note-bad" role="alert">{children}</p> : null);
export const Empty = ({ children }) => <p className="empty">{children}</p>;

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="btn btn-quiet" onClick={async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ } }}>{done ? 'Copied' : label}</button>;
}

// Shown ONCE after a key is issued. Lives only in component state; closing the dialog discards it for good.
export function OneTimeKey({ apiKey, who, onClose }) {
  return (
    <Modal title="Copy this key now" onClose={onClose}>
      <p>This is the only time the full key for <strong>{who}</strong> is shown. The gateway stores only a one-way hash, so it cannot be recovered later. If it is lost, revoke it and issue a new one.</p>
      <pre className="keybox" data-testid="one-time-key">{apiKey}</pre>
      <div className="actions"><CopyButton text={apiKey} label="Copy key" /><button type="button" className="btn btn-primary" onClick={onClose}>I have saved it</button></div>
    </Modal>
  );
}

export const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
