import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from './api.js';

// Load data on mount (and on reload()). Ignores results that arrive after unmount / a newer request.
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const run = useRef(0);
  const reload = useCallback(async () => {
    const id = ++run.current;
    setState((s) => ({ ...s, loading: true }));
    try { const data = await fn(); if (id === run.current) setState({ data, error: null, loading: false }); }
    catch (e) { if (id === run.current) setState({ data: null, error: errorText(e), loading: false }); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); return () => { run.current++; }; }, [reload]);
  return { ...state, reload };
}
