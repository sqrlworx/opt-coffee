// One answer's video, with its b-roll cut in as the phone plays it in the joined video: from
// `broll.start` for `broll.length` seconds, split screen, the expert moving to the top half while all
// of the b-roll plays in the bottom half, or full screen, all of it fading in over the whole stage.
// Either way the b-roll sits on a blurred copy of itself where its shape leaves room. It's muted (the
// expert's sound carries on) and kept in step. Full-screen b-roll the expert let run past the end of
// the answer plays on once the answer has ended, as the joined video has it: the timeline runs to its
// end, and the clip keeps the time while it plays alone. A video's own controls would end up in one
// half, so it gets these instead: play, the time, and a timeline marking where the b-roll is. Between
// cuts the take has the whole stage. The take fills its place, cropping more off the top than the
// bottom, except that a take alone on a phone turned sideways is shown whole. Without b-roll it's the
// video with its own controls, as it was. `videoRef` is the answer's <video>, for its transcript to
// follow, and for the planner to cut in to b-roll where it is.
import { useEffect, useRef, useState } from 'react';
import { fmtDuration } from '../format.js';
import { color } from '../theme.js';
import { Icon } from '../ui/icons.jsx';
import { BigPlay, CtrlButton, SeekBar } from './controls.jsx';
import { brollAt, focusPosition, playLength } from './split.js';
import { backStyle, drawBack, fixDuration, layer, stageStyle, useStage, Video } from './Video.jsx';

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
  const over = useRef(false); // the answer has ended, and its b-roll plays on past it
  const redraw = useRef(null);
  const [view, setView] = useState({ cut: false, second: 0, total: 0, playing: false });
  const length = () => (Number.isFinite(video.current?.duration) ? video.current.duration : 0);
  const playing = () => (over.current ? !clipRef.current.paused : !video.current.paused);

  useEffect(() => {
    const v = video.current;
    const clip = clipRef.current;
    clip.muted = true;
    const unfix = [fixDuration(v, { firstFrame: true }), fixDuration(clip)];
    let frame = 0;
    const tick = () => {
      const b = latest.current;
      const total = playLength(b, length());
      if (over.current && !(total > length())) over.current = false;
      const t = over.current ? b.start + clip.currentTime : v.currentTime;
      const cut = over.current || brollAt(b, t);
      if (cut && !over.current) {
        const at = t - b.start;
        if (Number.isFinite(clip.duration) && Math.abs(clip.currentTime - at) > 0.25) clip.currentTime = Math.min(at, clip.duration);
        if (v.paused) clip.pause();
        else if (clip.paused && !clip.ended) clip.play().catch(() => {});
      } else if (!cut) {
        clip.pause();
      }
      if (cut && backRef.current) drawBack(backRef.current, clip);
      if (fillRef.current) fillRef.current.style.width = `${total ? (100 * Math.min(t, total)) / total : 0}%`;
      const next = { cut, second: Math.floor(t), total, playing: playing() };
      setView((prev) => (prev.cut === next.cut && prev.second === next.second && prev.total === next.total && prev.playing === next.playing ? prev : next));
    };
    // Every frame while it plays, so the cut lands on time; timeupdate is only a few times a second.
    const loop = () => {
      tick();
      frame = playing() ? requestAnimationFrame(loop) : 0;
    };
    const onPlay = () => {
      cancelAnimationFrame(frame);
      loop();
    };
    const onPause = () => {
      // The answer has ended with b-roll still to play: it plays on, alone.
      if (v.ended && playLength(latest.current, length()) > length() && !over.current) {
        over.current = true;
        clip.play().catch(() => {});
      }
      tick();
    };
    const onClip = () => over.current && onPlay();
    const types = ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange'];
    // A paused clip shows the frame it was sent to only once it has it: the blurred copy follows then.
    const clipTypes = ['seeked', 'loadeddata'];
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    types.forEach((type) => v.addEventListener(type, tick));
    clipTypes.forEach((type) => clip.addEventListener(type, tick));
    ['play', 'pause'].forEach((type) => clip.addEventListener(type, onClip));
    redraw.current = tick;
    tick();
    return () => {
      unfix.forEach((f) => f());
      cancelAnimationFrame(frame);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      types.forEach((type) => v.removeEventListener(type, tick));
      clipTypes.forEach((type) => clip.removeEventListener(type, tick));
      ['play', 'pause'].forEach((type) => clip.removeEventListener(type, onClip));
    };
  }, [video]);
  // B-roll placed again (cut in elsewhere, or let run past the end) changes the stage while it's paused.
  useEffect(() => redraw.current?.(), [broll.start, broll.length, broll.full, broll.video]);

  function toggle() {
    const [v, clip] = [video.current, clipRef.current];
    if (!over.current) return v.paused || v.ended ? v.play().catch(() => {}) : v.pause();
    if (!clip.paused) return clip.pause();
    if (clip.ended || broll.start + clip.currentTime >= view.total - 0.05) {
      seek(0); // at the end of the b-roll: from the start again
      return v.play().catch(() => {});
    }
    clip.play().catch(() => {});
  }
  function seek(t) {
    const [v, clip] = [video.current, clipRef.current];
    const end = length();
    const total = playLength(broll, end);
    t = Math.max(0, Math.min(t, total || t));
    const wasPlaying = playing();
    if (total > end && t >= end) {
      // Past the end of the answer: it waits at its end, under the b-roll, which plays on from there.
      over.current = true;
      v.pause();
      v.currentTime = end;
      clip.currentTime = t - broll.start;
      if (wasPlaying) clip.play().catch(() => {});
    } else {
      if (over.current) {
        over.current = false;
        clip.pause();
        if (wasPlaying) v.play().catch(() => {});
      }
      v.currentTime = t;
    }
  }
  const { total } = view;
  const split = view.cut && !broll.full; // full-screen b-roll covers the take where it is

  return (
    <div ref={stageRef} className="split-stage" style={{ ...stageStyle, borderRadius: 12 }} onClick={toggle}>
      <video ref={video} src={src} preload="metadata" playsInline style={layer(split ? 'top' : 'full', wide, { fit: wide && !split ? 'contain' : 'cover', extra: { objectPosition: split ? focusPosition() : 'center' } })}>
        {captions ? <track key={captions} kind="subtitles" src={captions} srcLang="en" label="English" /> : null}
      </video>
      {/* Faded rather than taken out, so it has a size to draw at the moment the cut comes up, even paused. */}
      <div aria-hidden="true" style={layer(broll.full ? 'full' : 'bottom', wide, { shown: view.cut, z: 1, extra: { overflow: 'hidden' } })}>
        <canvas ref={backRef} style={backStyle} />
      </div>
      <video ref={clipRef} src={broll.video} preload="auto" playsInline aria-hidden="true" style={layer(broll.full ? 'full' : 'bottom', wide, { shown: view.cut, z: 2, fit: 'contain' })} />
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
