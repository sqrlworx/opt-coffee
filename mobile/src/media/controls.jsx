// The players' own controls, drawn over the split screen (a video's own would shrink into one half
// of it). Plain buttons rather than React Native ones, so a tap on one doesn't also count as a tap
// on the stage under it, which shows and hides them.
import { useRef } from 'react';
import { Icon } from '../ui/icons.jsx';

export function CtrlButton({ label, onPress, children, pressed, style }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={(e) => {
        e.stopPropagation();
        onPress();
      }}
      style={{ ...ctrlButton, opacity: pressed === false ? 0.5 : 1, ...style }}
    >
      {children}
    </button>
  );
}

// The timeline: drag along it to scrub, with `ticks` (fractions, 0-1) where each answer starts and
// `spans` ({ from, to, color, ahead }, fractions) marking stretches of it, like b-roll, over the
// played part: `color` where they've been played, and `ahead` where they haven't. `fillRef` is the
// played part, which the player sizes itself as it plays rather than re-rendering (see showPlayed).
// `onScrub(t)` hears where a finger is while it drags, and null when it lets go.
export function SeekBar({ total, value, fillRef, ticks = [], spans = [], onSeek, onScrub }) {
  const bar = useRef(null);
  const scrubbing = useRef(false);
  const timeAt = (e) => {
    const r = bar.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
  };
  const end = () => {
    scrubbing.current = false;
    onScrub?.(null);
  };
  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        scrubbing.current = true;
        bar.current.setPointerCapture(e.pointerId);
        const t = timeAt(e);
        onSeek(t);
        onScrub?.(t);
      }}
      onPointerMove={(e) => {
        if (!scrubbing.current) return;
        const t = timeAt(e);
        onSeek(t);
        onScrub?.(t);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        const step = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
        if (!step) return;
        e.preventDefault();
        onSeek(Math.max(0, Math.min(total, value + step)));
      }}
      style={{ position: 'relative', flex: 1, height: 36, display: 'flex', alignItems: 'center', touchAction: 'none', cursor: 'pointer' }}
    >
      <div style={{ position: 'relative', width: '100%', height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.3)' }}>
        <div ref={fillRef} style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '0%', borderRadius: 2, background: '#fff' }} />
        {spans.map((sp, i) => {
          const width = sp.to - sp.from || 1;
          const at = `calc((var(--played, 0) - ${sp.from}) / ${width} * 100%)`;
          return <span key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${100 * sp.from}%`, width: `${100 * (sp.to - sp.from)}%`, borderRadius: 2, background: `linear-gradient(to right, ${sp.color} ${at}, ${sp.ahead ?? sp.color} 0)` }} />;
        })}
        {/* The playhead, over the spans. */}
        <span style={{ position: 'absolute', top: -5, left: 'calc(var(--played, 0) * 100%)', width: 14, height: 14, marginLeft: -7, borderRadius: 7, background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.4)' }} />
        {ticks.map((at, i) => (
          <span key={i} style={{ position: 'absolute', top: 0, bottom: 0, left: `${100 * at}%`, width: 3, marginLeft: -1.5, background: 'rgba(0,0,0,0.75)' }} />
        ))}
      </div>
    </div>
  );
}

// Shows how much of a SeekBar's timeline has played, `fraction` (0-1), on its `fillRef`: the played
// part, and where the playhead and the spans' played parts reach.
export function showPlayed(fillRef, fraction) {
  const fill = fillRef.current;
  if (!fill) return;
  fill.style.width = `${100 * fraction}%`;
  fill.parentElement.style.setProperty('--played', fraction);
}

export function BigPlay({ playing = false, onPress, label }) {
  return (
    <button
      type="button"
      aria-label={label ?? (playing ? 'Pause' : 'Play')}
      onClick={(e) => {
        e.stopPropagation();
        onPress();
      }}
      style={bigPlay}
    >
      <Icon name={playing ? 'pause' : 'play'} size={34} color="#1c1a17" />
    </button>
  );
}

const ctrlButton = { display: 'inline-grid', placeItems: 'center', minWidth: 44, height: 44, padding: '0 8px', border: 'none', borderRadius: 10, background: 'none', color: '#fff', font: 'inherit', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const bigPlay = { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 72, height: 72, display: 'grid', placeItems: 'center', border: 'none', borderRadius: '50%', background: 'rgba(255,255,255,0.92)', boxShadow: '0 8px 30px rgba(0,0,0,0.35)', cursor: 'pointer', zIndex: 6, paddingLeft: 4 };
