// Dates, times and counts, as the page shows them.

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function relative(iso, now = Date.now()) {
  const diff = (new Date(iso) - now) / 1000;
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return diff >= 0 ? 'in a moment' : 'just now';
}

export function fmtDuration(secs) {
  const s = Math.floor(Math.max(0, secs) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// The time left until `end` (ms), as [[2, 'd'], [5, 'h'], [9, 'm'], [30, 's']]: from the first unit
// that isn't zero, the ones after it with two digits, so it doesn't jump about. Empty once it's past.
export function countdownParts(end, now = Date.now()) {
  const left = Math.max(0, Math.ceil((end - now) / 1000));
  if (!left) return [];
  const units = [[Math.floor(left / 86400), 'd'], [Math.floor(left / 3600) % 24, 'h'], [Math.floor(left / 60) % 60, 'm'], [left % 60, 's']];
  return units.slice(units.findIndex(([n]) => n > 0)).map(([n, unit], i) => [i ? String(n).padStart(2, '0') : String(n), unit]);
}

export function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Who asked a question, after it in the summary and discussion.
export const askedBy = (q) => (q.source === 'moderator' ? 'suggested by the moderator' : q.anonymous ? 'anonymous' : q.author?.displayName);
// Who's asking, on their half of the player while a question is played.
export const askerLabel = (q) => (q.source === 'moderator' ? 'Suggested question' : q.anonymous || !q.author ? 'Anonymous' : q.author.displayName);
