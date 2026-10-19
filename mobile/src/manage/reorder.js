// Dragging a card through the answer order, as arithmetic, apart from React so it can be tested
// (useReorder.js does the dragging). Cards are their tops and heights in page pixels, where they lay
// before any moved.

// Where the held card, dragged `dy`, would go: after every other card whose middle its own has passed.
export function dropIndex(tops, heights, from, dy) {
  const middle = tops[from] + dy + heights[from] / 2;
  return tops.filter((top, i) => i !== from && top + heights[i] / 2 < middle).length;
}

// How far each card slides to make room for it there: the ones it has passed, by its height and the
// gap between cards, up if it went down and down if it went up.
export function shifts(heights, from, to, gap) {
  const room = heights[from] + gap;
  return heights.map((_, i) => (i > from && i <= to ? -room : i < from && i >= to ? room : 0));
}

// `list` with its item at `from` moved to `to`.
export function moved(list, from, to) {
  const next = list.filter((_, i) => i !== from);
  next.splice(to, 0, list[from]);
  return next;
}

// How fast the page scrolls while a card is held at `y` on screen, in pixels a millisecond, up near
// the bar ending at `top` and down near the one starting at `bottom`: faster the further into the
// `band` along either.
export function scrollSpeed(y, top, bottom, band = 64, max = 1.2) {
  if (y < top + band) return -max * Math.min(1, (top + band - y) / band);
  if (y > bottom - band) return max * Math.min(1, (y - bottom + band) / band);
  return 0;
}
