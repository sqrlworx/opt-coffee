// A card in a list that slides left under the finger to show a button behind it, as phones' lists
// do: let go past halfway and it stays open, short of that and it slides back. A tap on an open card,
// or on any card while another is open, only closes it, and so does scrolling or pressing elsewhere.
// Fields keep the finger to themselves, and so does anything that stops its event (the grips).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, font, radius } from '../theme.js';

const WIDTH = 96; // how far it opens: the button's width
const SLOP = 8; // pixels a finger moves before it's a swipe, or a scroll

// `open` is whether this card is open, `others` whether another is; `setOpen(on)` opens this one, or
// closes whichever is. The button says `title`, `label` is what it does, and `onAction` does it.
export function SwipeRow({ open, others, setOpen, title, label, onAction, children }) {
  const slot = useRef(null);
  const layer = useRef(null);
  const swipe = useRef(null);
  const swallow = useRef(false); // the click after a swipe, or after a tap that only closed a card
  const ask = useRef(setOpen);
  ask.current = setOpen;
  const place = (x, animate) => {
    const s = layer.current.style;
    s.transition = animate ? 'transform 200ms ease' : '';
    s.transform = x ? `translateX(${x}px)` : '';
  };
  useLayoutEffect(() => place(open ? -WIDTH : 0, true), [open]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => slot.current?.contains(e.target) || ask.current(false);
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);

  return (
    <View ref={slot} style={styles.slot}>
      <View style={styles.behind}>
        <Pressable role="button" aria-label={label} onPress={onAction} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} style={styles.action}>
          <Text style={styles.actionText}>{title}</Text>
        </Pressable>
      </View>
      <div
        ref={layer}
        style={layerStyle}
        onPointerDown={(e) => {
          swallow.current = false;
          if (e.button > 0 || e.target.closest('input, textarea, select')) return;
          swipe.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: open ? -WIDTH : 0, closing: open || others };
        }}
        onPointerMove={(e) => {
          const g = swipe.current;
          if (g?.id !== e.pointerId) return;
          const dx = e.clientX - g.x0;
          if (!g.on) {
            if (Math.abs(e.clientY - g.y0) > SLOP) {
              swipe.current = null; // a scroll, which is the browser's
              if (g.closing) setOpen(false);
              return;
            }
            if (Math.abs(dx) < SLOP) return;
            g.on = true;
            e.currentTarget.setPointerCapture(e.pointerId);
          }
          place(Math.min(0, Math.max(-WIDTH - 24, g.from + dx)), false);
        }}
        onPointerUp={(e) => {
          const g = swipe.current;
          if (g?.id !== e.pointerId) return;
          swipe.current = null;
          if (!g.on) {
            if (g.closing) {
              swallow.current = true;
              setOpen(false);
            }
            return;
          }
          swallow.current = true; // a mouse clicks where it's let go
          const on = g.from + e.clientX - g.x0 < -WIDTH / 2;
          if (on === open) place(open ? -WIDTH : 0, true);
          else setOpen(on);
        }}
        onPointerCancel={(e) => {
          if (swipe.current?.id !== e.pointerId) return;
          swipe.current = null;
          place(open ? -WIDTH : 0, true);
        }}
        onClickCapture={(e) => {
          if (!swallow.current) return;
          swallow.current = false;
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        {children}
      </div>
    </View>
  );
}

const layerStyle = { position: 'relative', touchAction: 'pan-y' }; // sideways is the card's, up and down the page's

const styles = StyleSheet.create({
  slot: { borderRadius: radius.lg },
  // Inset a little, so its edge doesn't show around the card's corners.
  behind: { position: 'absolute', top: 2, bottom: 2, right: 2, width: WIDTH + radius.lg, borderRadius: radius.lg - 2, backgroundColor: color.accent, alignItems: 'flex-end' },
  // Its words near the top, where the question is: a card with an answer is taller than the screen.
  action: { width: WIDTH - 2, flex: 1, alignItems: 'center', paddingTop: 24, cursor: 'pointer' },
  actionText: { fontFamily: font.sans, fontSize: 15, fontWeight: '600', color: color.accentInk },
});
