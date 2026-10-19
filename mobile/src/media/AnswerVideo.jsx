// One answer's video, with its b-roll cut in as it is in the joined video (src/video.js), but split
// screen: from `broll.start` for `broll.length` seconds, the expert moves to the top half and the
// b-roll plays in the bottom half, muted (the expert's sound carries on) and kept in step. A video's
// own controls would end up in one half, so it gets these instead: play, the time, and a timeline
// marking where the b-roll is. Between cuts the take has the whole stage. Each fills its place,
// except that a take alone on a phone turned sideways is shown whole. Without b-roll it's the video
// with its own controls, as it was. `videoRef` is the answer's <video>, for its transcript to follow.
import { useEffect, useRef, useState } from 'react';
import { fmtDuration } from '../format.js';
import { color } from '../theme.js';
import { Icon } from '../ui/icons.jsx';
import { BigPlay, CtrlButton, SeekBar } from './controls.jsx';
import { brollAt } from './split.js';
import { fixDuration, layer, stageStyle, useStage, Video } from './Video.jsx';

export function AnswerVideo({ src, captions, broll, videoRef }) {
  const placed = broll?.video && broll.start != null ? broll : null;
  if (!placed) {
    return (
      <Video ref={videoRef} src={src} controls style={{ background: '#111', borderRadius: 12 }}>
        {captions ? <track key={captions} kind="subtitles" src={captions} srcLang="en" label="English" /> : null}
      </Video>
    );
  }
  return <BrollStage src={src} captions={captions} broll={placed} videoRef={videoRef} />;
}

function BrollStage({ src, captions, broll, videoRef }) {
  const { ref: stageRef, wide } = useStage();
  const own = useRef(null);
  const video = videoRef ?? own;
  const clipRef = useRef(null);
  const fillRef = useRef(null);
  const latest = useRef(broll);
  latest.current = broll;
  const [view, setView] = useState({ cut: false, second: 0, total: 0, playing: false });

  useEffect(() => {
    const v = video.current;
    const clip = clipRef.current;
    clip.muted = true;
    const unfix = [fixDuration(v, { firstFrame: true }), fixDuration(clip)];
    let frame = 0;
    const tick = () => {
      const b = latest.current;
      const t = v.currentTime;
      const total = Number.isFinite(v.duration) ? v.duration : 0;
      const cut = brollAt(b, t);
      if (cut) {
        const at = t - b.start;
        if (Number.isFinite(clip.duration) && Math.abs(clip.currentTime - at) > 0.25) clip.currentTime = Math.min(at, clip.duration);
        if (v.paused) clip.pause();
        else if (clip.paused && !clip.ended) clip.play().catch(() => {});
      } else {
        clip.pause();
      }
      if (fillRef.current) fillRef.current.style.width = `${total ? (100 * t) / total : 0}%`;
      const next = { cut, second: Math.floor(t), total, playing: !v.paused };
      setView((prev) => (prev.cut === next.cut && prev.second === next.second && prev.total === next.total && prev.playing === next.playing ? prev : next));
    };
    // Every frame while it plays, so the cut lands on time; timeupdate is only a few times a second.
    const loop = () => {
      tick();
      frame = v.paused ? 0 : requestAnimationFrame(loop);
    };
    const onPlay = () => {
      cancelAnimationFrame(frame);
      loop();
    };
    const types = ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'pause'];
    v.addEventListener('play', onPlay);
    types.forEach((type) => v.addEventListener(type, tick));
    tick();
    return () => {
      unfix.forEach((f) => f());
      cancelAnimationFrame(frame);
      v.removeEventListener('play', onPlay);
      types.forEach((type) => v.removeEventListener(type, tick));
    };
  }, [video]);

  const toggle = () => (video.current.paused || video.current.ended ? video.current.play().catch(() => {}) : video.current.pause());
  const seek = (t) => (video.current.currentTime = Math.max(0, Math.min(t, view.total || t)));
  const { total } = view;

  return (
    <div ref={stageRef} className="split-stage" style={{ ...stageStyle, borderRadius: 12 }} onClick={toggle}>
      <video ref={video} src={src} preload="metadata" playsInline style={layer(view.cut ? 'top' : 'full', wide, { fit: wide && !view.cut ? 'contain' : 'cover' })}>
        {captions ? <track key={captions} kind="subtitles" src={captions} srcLang="en" label="English" /> : null}
      </video>
      <video ref={clipRef} src={broll.video} preload="auto" playsInline aria-hidden="true" style={layer('bottom', wide, { shown: view.cut, z: 1 })} />
      {view.playing ? null : <BigPlay onPress={toggle} />}
      <div style={controlsBar} onClick={(e) => e.stopPropagation()}>
        <CtrlButton label={view.playing ? 'Pause' : 'Play'} onPress={toggle}>
          <Icon name={view.playing ? 'pause' : 'play'} color="#fff" />
        </CtrlButton>
        <span style={timeStyle}>
          {fmtDuration(view.second)} / {fmtDuration(total)}
        </span>
        <SeekBar total={total} value={view.second} fillRef={fillRef} spans={total ? [{ from: broll.start / total, to: Math.min(1, (broll.start + broll.length) / total), color: color.brollSpan }] : []} onSeek={seek} />
      </div>
    </div>
  );
}

const controlsBar = { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: 6, padding: '22px 12px 2px 4px', background: 'linear-gradient(transparent, rgba(0,0,0,0.6))' };
const timeStyle = { color: '#fff', fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
