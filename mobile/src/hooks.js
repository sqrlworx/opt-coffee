import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api } from './api.js';

export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => (mounted.current = false);
  }, []);
  return mounted;
}

// For state kept in refs and changed in place (as the planner's is): re-renders when called.
export function useBump() {
  return useReducer((n) => n + 1, 0)[1];
}

// Loads a page's data. `reload()` loads it again; `data` stays meanwhile, so the page doesn't blank.
export function useLoad(load, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    load().then(
      (data) => mine === seq.current && setState({ data, error: null, loading: false }),
      (error) => mine === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(run, [run]);
  return { ...state, reload: run };
}

// Speech, b-roll and videos are processed in the background. While `active`, re-fetches question
// `id` every few seconds until `done(question)` holds, then calls `then(question)`. Stops when the
// component goes away.
export function useWatchQuestion(id, active, done, then) {
  const latest = useRef({ done, then });
  latest.current = { done, then };
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        const { question } = await api('GET', `/api/questions/${id}`, null, { timeout: 10_000 });
        if (stopped) return;
        if (latest.current.done(question)) return latest.current.then(question);
      } catch {
        // failed or hung: try again on the next tick
      }
      if (!stopped) timer = setTimeout(tick, 3000);
    };
    timer = setTimeout(tick, 3000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id, active]);
}

// While `active`, leaving or reloading the page asks first (work in progress would be lost).
export function useLeaveGuard(active) {
  useEffect(() => {
    if (!active) return;
    const guard = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [active]);
}

// Re-renders every `ms` while mounted (for relative times and countdowns).
export function useNow(ms) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ms) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
