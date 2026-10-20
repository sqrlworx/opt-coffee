// One answer's video, with its b-roll cut in as the phone plays it in the joined video: from
// `broll.start` for `broll.length` seconds, split screen, the expert moving to the top half while the
// b-roll plays in the bottom half, or full screen, all of the b-roll fading in over the whole stage,
// on a blurred copy of itself where its shape leaves room. The b-roll is muted (the expert's sound
// carries on) and kept in step. A video's own controls would end up in one half, so it gets these
// instead: play, the time, and a timeline marking where the b-roll is. Between cuts the take has the
// whole stage. The take and split-screen b-roll fill their places, cropping more off the top than the
// bottom, except that a take alone on a phone turned sideways is shown whole. Without b-roll it's the
// video with its own controls, as it was. `videoRef` is the answer's <video>, for its transcript to
// follow.
import { useEffect, useRef, useState } from 'react';
import { fmtDuration } from '../format.js';
import { color } from '../theme.js';
import { Icon } from '../ui/icons.jsx';
import { BigPlay, CtrlButton, SeekBar } from './controls.jsx';
import { brollAt, cover, focusPosition } from './split.js';
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
  const backRef = useRef(null);
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
        if (b.full && backRef.current) drawBack(backRef.current, clip);
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
    // A paused clip shows the frame it was sent to only once it has it: the blurred copy follows then.
    const clipTypes = ['seeked', 'loadeddata'];
    v.addEventListener('play', onPlay);
    types.forEach((type) => v.addEventListener(type, tick));
    clipTypes.forEach((type) => clip.addEventListener(type, tick));
    tick();
    return () => {
      unfix.forEach((f) => f());
      cancelAnimationFrame(frame);
      v.removeEventListener('play', onPlay);
      types.forEach((type) => v.removeEventListener(type, tick));
      clipTypes.forEach((type) => clip.removeEventListener(type, tick));
    };
  }, [video]);

  const toggle = () => (video.current.paused || video.current.ended ? video.current.play().catch(() => {}) : video.current.pause());
  const seek = (t) => (video.current.currentTime = Math.max(0, Math.min(t, view.total || t)));
  const { total } = view;
  const split = view.cut && !broll.full; // full-screen b-roll covers the take where it is

  return (
    <div ref={stageRef} className="split-stage" style={{ ...stageStyle, borderRadius: 12 }} onClick={toggle}>
      <video ref={video} src={src} preload="metadata" playsInline style={layer(split ? 'top' : 'full', wide, { fit: wide && !split ? 'contain' : 'cover', extra: { objectPosition: split ? focusPosition() : 'center' } })}>
        {captions ? <track key={captions} kind="subtitles" src={captions} srcLang="en" label="English" /> : null}
      </video>
      {/* Faded rather than taken out, so it has a size to draw at the moment the cut comes up, even paused. */}
      {broll.full ? <canvas ref={backRef} aria-hidden="true" style={layer('full', wide, { shown: view.cut, z: 1, extra: backStyle })} /> : null}
      <video ref={clipRef} src={broll.video} preload="auto" playsInline aria-hidden="true" style={layer(broll.full ? 'full' : 'bottom', wide, { shown: view.cut, z: 2, fit: broll.full ? 'contain' : 'cover' })} />
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

// The clip, drawn small to fill the stage, for the blurred copy of itself that full-screen b-roll
// sits on, as the joined video has it (cutawayFilter in src/video.js).
function drawBack(canvas, clip) {
  const [w, h] = [Math.round(canvas.clientWidth / 4), Math.round(canvas.clientHeight / 4)];
  if (!w || !h || !clip.videoWidth || clip.readyState < 2) return;
  if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
  const [x, y, cw, ch] = cover(clip.videoWidth, clip.videoHeight, w, h);
  canvas.getContext('2d').drawImage(clip, x, y, cw, ch, 0, 0, w, h);
}

const backStyle = { filter: 'blur(12px) brightness(0.9) saturate(0.7)', transform: 'scale(1.1)' };
const controlsBar = { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: 6, padding: '22px 12px 2px 4px', background: 'linear-gradient(transparent, rgba(0,0,0,0.6))' };
const timeStyle = { color: '#fff', fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
