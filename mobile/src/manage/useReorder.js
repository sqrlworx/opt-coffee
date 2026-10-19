// Moving a card in the answer order by dragging its grip, or with the arrow keys on it. While one is
// held every card folds to its question, so it can go a long way without carrying answer videos past
// each other: the held card follows the finger, the others slide out of its way, and the page scrolls
// while it's near the top or bottom. Folding hides rather than unmounts, so players keep their place.
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { dropIndex, moved, scrollSpeed, shifts } from './reorder.js';

const SLOP = 6; // pixels a finger moves before it's a drag rather than a tap

// `edges()` is where the bars the page scrolls under end on screen, [top, bottom]. `list` goes on the
// view whose children are the cards, in order; `handle(qid, i)` gives the props for card i's grip.
export function useReorder(queue, setQueue, edges) {
  const [held, setHeld] = useState(null); // the question being moved
  const list = useRef(null);
  const drag = useRef(null);
  const latest = useRef(null);
  latest.current = { queue, setQueue, edges };
  useEffect(() => () => cancelAnimationFrame(drag.current?.frame), []);

  // Changes the layout, then scrolls so `node` is where it was on screen. The browser's scroll
  // anchoring would correct for it as well, so that's off until the next frame.
  const keepPlace = (node, change) => {
    const at = node.getBoundingClientRect().top;
    const body = document.body.style;
    body.overflowAnchor = 'none';
    change();
    window.scrollBy(0, node.getBoundingClientRect().top - at);
    requestAnimationFrame(() => (body.overflowAnchor = ''));
  };

  const fold = (g) => {
    const box = list.current;
    const card = box.children[g.from];
    keepPlace(card, () => {
      const before = box.offsetHeight;
      flushSync(() => setHeld(g.qid));
      box.style.paddingBottom = `${before - box.offsetHeight}px`; // the page keeps its length, so the scroll back is never cut short
    });
    g.nodes = [...box.children];
    g.tops = g.nodes.map((n) => n.getBoundingClientRect().top + window.scrollY);
    g.heights = g.nodes.map((n) => n.offsetHeight);
    g.gap = g.nodes.length > 1 ? g.tops[1] - g.tops[0] - g.heights[0] : 0;
    g.to = g.from;
    // From here the card moves as the finger does, from wherever folding left it.
    g.grab = g.y + window.scrollY - g.tops[g.from];
    Object.assign(card.style, { zIndex: 1, boxShadow: '0 14px 34px -10px rgba(40,30,20,0.4)' });
    for (const n of g.nodes) if (n !== card) n.style.transition = 'transform 150ms';
    g.frame = requestAnimationFrame((now) => tick(g, now));
  };

  // The held card under the finger, and the cards it has passed out of its way.
  const follow = (g) => {
    g.sy = window.scrollY;
    const dy = g.y + g.sy - g.grab - g.tops[g.from];
    g.nodes[g.from].style.transform = `translateY(${dy}px)`;
    const to = dropIndex(g.tops, g.heights, g.from, dy);
    if (to === g.to) return;
    g.to = to;
    shifts(g.heights, g.from, to, g.gap).forEach((y, i) => i !== g.from && (g.nodes[i].style.transform = y ? `translateY(${y}px)` : ''));
  };

  // Near a bar the page scrolls every frame (a finger held still sends nothing), but no further than
  // shows the first or last card: past that is only padding.
  const tick = (g, now) => {
    const [top, bottom] = latest.current.edges();
    const v = scrollSpeed(g.y, top, bottom) * (g.t ? Math.min(48, now - g.t) : 16);
    g.t = now;
    const y = window.scrollY;
    const lo = g.tops[0] - top;
    const hi = g.tops.at(-1) + g.heights.at(-1) - bottom;
    if (v < 0 && y > lo) window.scrollTo(0, Math.max(lo, y + v));
    else if (v > 0 && y < hi) window.scrollTo(0, Math.min(hi, y + v));
    if (window.scrollY !== g.sy) follow(g); // scrolled, by this or by the browser's own bars
    g.frame = requestAnimationFrame((t) => tick(g, t));
  };

  // Let go: the card stays where it was left, in its new place, and the cards around it unfold. The
  // order changes only now, since moving the grip mid-drag would lose its hold on the finger.
  const end = (e, drop) => {
    const g = drag.current;
    if (g?.id !== e.pointerId) return;
    drag.current = null;
    if (!g.nodes) return; // a tap
    cancelAnimationFrame(g.frame);
    const { queue: q, setQueue: set } = latest.current;
    keepPlace(g.nodes[g.from], () => {
      for (const n of g.nodes) n.style.transform = n.style.transition = n.style.zIndex = n.style.boxShadow = '';
      list.current.style.paddingBottom = '';
      flushSync(() => {
        setHeld(null);
        if (drop && g.to !== g.from && q[g.from] === g.qid) set(moved(q, g.from, g.to));
      });
    });
  };

  // A plain element, as the seek bar is (media/controls.jsx), so it has the pointer to itself.
  const handle = (qid, i) => ({
    role: 'button',
    tabIndex: 0,
    'aria-label': `Move question ${i + 1}: drag it, or press the up and down arrow keys`,
    title: 'Drag to reorder',
    style: grip,
    onPointerDown(e) {
      e.stopPropagation(); // a press on the grip moves the card, never slides it (SwipeRow.jsx)
      if (drag.current || e.button > 0 || latest.current.queue.length < 2) return;
      e.preventDefault(); // so a mouse doesn't select text
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { id: e.pointerId, qid, from: i, y0: e.clientY, y: e.clientY };
    },
    onPointerMove(e) {
      const g = drag.current;
      if (g?.id !== e.pointerId) return;
      g.y = e.clientY;
      if (!g.nodes) {
        if (Math.abs(g.y - g.y0) < SLOP) return;
        fold(g);
      }
      follow(g);
    },
    onPointerUp: (e) => end(e, true),
    onPointerCancel: (e) => end(e, false),
    onLostPointerCapture: (e) => end(e, false),
    onKeyDown(e) {
      const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const { queue: q, setQueue: set } = latest.current;
      if (drag.current || q[i + step] == null) return;
      // React keeps the grip focused as its card moves; this keeps the card on screen.
      keepPlace(list.current.children[i], () => flushSync(() => set(moved(q, i, i + step))));
    },
  });

  return { held, list, handle };
}

const grip = { width: 44, height: 44, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 22, cursor: 'grab', touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' };
