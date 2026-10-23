// One answer's video, with its b-roll cut in as the phone plays it in the joined video: each clip in
// `brolls` from its `start` for `length` seconds, split screen, the expert moving to the top half
// while all of the clip plays in the bottom half, or full screen, all of it fading in over the whole
// stage. Either way the b-roll sits on a blurred copy of itself where its shape leaves room. It's
// muted (the expert's sound carries on) and kept in step. Full-screen b-roll the expert let run past
// the end of the answer plays on once the answer has ended, as the joined video has it: the timeline
// runs to its end, and the clip keeps the time while it plays alone. A video's own controls would end
// up in one half, so it gets these instead: play, the time, and a timeline marking where each clip
// is. Between cuts the take has the whole stage. The take fills its place, cropping more off the top
// than the bottom, except that a take alone on a phone turned sideways is shown whole. Without b-roll
// it's the video with its own controls, as it was. `videoRef` is the answer's <video>, for its
// transcript to follow, and for the planner to cut in to b-roll where it is.
import { useEffect, useRef, useState } from 'react';
import { fmtDuration } from '../format.js';
import { color } from '../theme.js';
import { Icon } from '../ui/icons.jsx';
import { BigPlay, CtrlButton, SeekBar, showPlayed } from './controls.jsx';
import { brollAt, focusPosition, playLength } from './split.js';
import { advancing, backStyle, drawBack, fixDuration, layer, stageStyle, useStage, Video } from './Video.jsx';

export function AnswerVideo({ src, captions, brolls, videoRef }) {
  const placed = (brolls ?? []).filter((b) => b.video && b.start != null).sort((a, b) => a.start - b.start);
  if (!placed.length) {
    return (
      <Video ref={videoRef} src={src} controls style={{ background: '#111', borderRadius: 12 }}>
        {captions ? <track key={captions} kind="subtitles" src={captions} srcLang="en" label="English" /> : null}
      </Video>
    );
  }
  return <BrollStage src={src} captions={captions} brolls={placed} videoRef={videoRef} />;
}

function BrollStage({ src, captions, brolls, videoRef }) {
  const { ref: stageRef, wide } = useStage();
  const own = useRef(null);
  const video = videoRef ?? own;
  const clipRefs = useRef(new Map()); // clip's URL -> its <video>
  const backRef = useRef(null);
  const fillRef = useRef(null);
  const latest = useRef(brolls);
  latest.current = brolls;
  const over = useRef(false); // the answer has ended, and its last clip plays on past it
  const redraw = useRef(null);
  // `shown` is the clip cut to now, or last, which stays while the cut fades back out.
  const [view, setView] = useState({ cut: false, shown: brolls[0].video, second: 0, total: 0, playing: false });
  const length = () => (Number.isFinite(video.current?.duration) ? video.current.duration : 0);
  const last = () => latest.current.at(-1);
  const clipEl = (b) => clipRefs.current.get(b.video);
  const playing = () => (over.current ? !clipEl(last())?.paused : !video.current.paused);

  useEffect(() => {
    const v = video.current;
    const unfix = fixDuration(v, { firstFrame: true });
    let frame = 0;
    const tick = () => {
      const all = latest.current;
      const total = playLength(all, length());
      if (over.current && !(total > length())) over.current = false;
      const t = over.current ? last().start + (clipEl(last())?.currentTime ?? 0) : v.currentTime;
      const current = over.current ? last() : brollAt(all, t);
      for (const b of all) if (b !== current) clipEl(b)?.pause();
      const clip = current && clipEl(current);
      if (clip && !over.current) {
        const at = t - current.start;
        if (Number.isFinite(clip.duration) && Math.abs(clip.currentTime - at) > 0.25) clip.currentTime = Math.min(at, clip.duration);
        if (!advancing(v)) clip.pause();
        else if (clip.paused && !clip.ended) clip.play().catch(() => {});
      }
      if (clip && backRef.current) drawBack(backRef.current, clip);
      showPlayed(fillRef, total ? Math.min(t, total) / total : 0);
      setView((prev) => {
        const next = { cut: Boolean(current), shown: current?.video ?? prev.shown, second: Math.floor(t), total, playing: playing() };
        return Object.keys(next).every((key) => prev[key] === next[key]) ? prev : next;
      });
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
        clipEl(last())?.play().catch(() => {});
      }
      tick();
    };
    const types = ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange'];
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    types.forEach((type) => v.addEventListener(type, tick));
    redraw.current = { tick, onPlay };
    tick();
    return () => {
      unfix();
      cancelAnimationFrame(frame);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      types.forEach((type) => v.removeEventListener(type, tick));
    };
  }, [video]);
  // B-roll placed again (cut in elsewhere, let run past the end, or another clip added) changes the stage while it's paused.
  const placing = brolls.map((b) => `${b.video},${b.start},${b.length},${b.full}`).join(';');
  useEffect(() => redraw.current?.tick(), [placing]);

  // Each clip's <video>, which follows the take once it's there. One ref callback for each clip, so
  // React doesn't hand it over again on every render.
  const refs = useRef(new Map()); // clip's URL -> its ref callback
  const clipRef = (b) => {
    if (!refs.current.has(b.video)) {
      refs.current.set(b.video, (el) => {
        if (!el) return void clipRefs.current.delete(b.video);
        clipRefs.current.set(b.video, el);
        el.muted = true;
        fixDuration(el);
        // A paused clip shows the frame it was sent to only once it has it: the blurred copy follows then.
        ['seeked', 'loadeddata'].forEach((type) => el.addEventListener(type, () => redraw.current?.tick()));
        ['play', 'pause'].forEach((type) => el.addEventListener(type, () => over.current && redraw.current?.onPlay()));
      });
    }
    return refs.current.get(b.video);
  };

  function toggle() {
    const v = video.current;
    if (!over.current) return v.paused || v.ended ? v.play().catch(() => {}) : v.pause();
    const clip = clipEl(last());
    if (!clip.paused) return clip.pause();
    if (clip.ended || last().start + clip.currentTime >= view.total - 0.05) {
      seek(0); // at the end of the b-roll: from the start again
      return v.play().catch(() => {});
    }
    clip.play().catch(() => {});
  }
  function seek(t) {
    const v = video.current;
    const end = length();
    const total = playLength(brolls, end);
    t = Math.max(0, Math.min(t, total || t));
    const wasPlaying = playing();
    const clip = clipEl(last());
    if (total > end && t >= end) {
      // Past the end of the answer: it waits at its end, under the b-roll, which plays on from there.
      over.current = true;
      v.pause();
      v.currentTime = end;
      clip.currentTime = t - last().start;
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
  const shown = brolls.find((b) => b.video === view.shown) ?? brolls[0];
  const split = view.cut && !shown.full; // full-screen b-roll covers the take where it is

  return (
    <div ref={stageRef} className="split-stage" style={{ ...stageStyle, borderRadius: 12 }} onClick={toggle}>
      <video ref={video} src={src} preload="metadata" playsInline style={layer(split ? 'top' : 'full', wide, { fit: wide && !split ? 'contain' : 'cover', extra: { objectPosition: split ? focusPosition() : 'center' } })}>
        {captions ? <track key={captions} kind="subtitles" src={captions} srcLang="en" label="English" /> : null}
      </video>
      {/* Faded rather than taken out, so it has a size to draw at the moment the cut comes up, even paused. */}
      <div aria-hidden="true" style={layer(shown.full ? 'full' : 'bottom', wide, { shown: view.cut, z: 1, extra: { overflow: 'hidden' } })}>
        <canvas ref={backRef} style={backStyle} />
      </div>
      {/* A <video> for each clip, so each is loaded before its cut comes up. */}
      {brolls.map((b) => (
        <video key={b.video} ref={clipRef(b)} src={b.video} preload="auto" playsInline aria-hidden="true" style={layer(b.full ? 'full' : 'bottom', wide, { shown: view.cut && b === shown, z: 2, fit: 'contain' })} />
      ))}
      {view.playing ? null : <BigPlay onPress={toggle} />}
      <div style={controlsBar} onClick={(e) => e.stopPropagation()}>
        <CtrlButton label={view.playing ? 'Pause' : 'Play'} onPress={toggle}>
          <Icon name={view.playing ? 'pause' : 'play'} color="#fff" />
        </CtrlButton>
        <span style={timeStyle}>
          {fmtDuration(view.second)} / {fmtDuration(total)}
        </span>
        <SeekBar total={total} value={view.second} fillRef={fillRef} spans={total ? brolls.map((b) => ({ from: b.start / total, to: Math.min(1, (b.start + b.length) / total), color: color.brollSpan, ahead: color.brollSpanAhead })) : []} onSeek={seek} />
      </div>
    </div>
  );
}

const controlsBar = { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: 6, padding: '22px 12px 2px 4px', background: 'linear-gradient(transparent, rgba(0,0,0,0.6))' };
const timeStyle = { color: '#fff', fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
