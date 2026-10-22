import { useEffect, useState } from 'react';

// Hash routing, with the same routes as the page (#/oh/3, #/u/maya, …), so a link from one works in
// the other with /m/ in front.
export const ROUTES = [
  [/^#?\/?$/, 'feed', { auth: true }],
  [/^#\/explore$/, 'explore'],
  [/^#\/oh\/new$/, 'new', { auth: true }],
  [/^#\/oh\/(?<id>\d+)$/, 'officeHour'],
  [/^#\/oh\/(?<id>\d+)\/manage$/, 'manage', { auth: true }],
  [/^#\/u\/(?<username>\w+)$/, 'profile'],
  [/^#\/login$/, 'login'],
];

export function match(hash) {
  const [path, qs = ''] = hash.split('?');
  const query = new URLSearchParams(qs);
  for (const [re, name, opts = {}] of ROUTES) {
    const m = path.match(re);
    if (m) return { name, params: m.groups ?? {}, query, auth: Boolean(opts.auth), path };
  }
  return { name: 'notFound', params: {}, query, auth: false, path };
}

// Explore, searching for `q`, among off hours with `status` (`open`, `answered` or `all`).
export const searchHash = (q, status = 'all') => `#/explore?q=${encodeURIComponent(q)}${status === 'all' ? '' : `&status=${status}`}`;

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

// The current hash, and a counter that changes on every navigation, even to the same page, so it
// loads again (as the page's render() does).
export function useHash() {
  const [state, setState] = useState(() => ({ hash: location.hash, visit: 0 }));
  useEffect(() => {
    const onChange = () => {
      document.querySelectorAll('audio, video').forEach((m) => m.pause()); // removing them doesn't stop playback
      setState((s) => ({ hash: location.hash, visit: s.visit + 1 }));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return state;
}
