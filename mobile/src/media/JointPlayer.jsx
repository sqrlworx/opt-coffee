// The published answers as one video: the takes joined end to end on the server (src/video.js),
// as the page's jointPlayer plays them, but split screen instead of picture in picture.
//
// While a question is played (the start of each take, up to its `answerStart`), the asker takes
// the top half: their video for a question asked on camera, kept in step with the question, and
// otherwise the fox saying it. The joined video moves to the bottom half. While an answer's b-roll
// plays, the server has drawn the expert into the corner of the joined video's picture; here the
// expert is cropped back out of it into the top half, and the clip itself plays in the bottom half,
// in step. The rest of the time the joined video plays alone, between the halves.
//
// It has its own controls (a video's own would shrink into one half), which fade while it plays
// until the stage is tapped. Captions are drawn at the bottom of the main picture, except for
// answers whose captions are burned into the video, and those too while their b-roll covers them.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { blinkAt, fox } from '../../../public/fox.js';
import { api } from '../api.js';
import { askerLabel, fmtDuration } from '../format.js';
import { Icon } from '../ui/icons.jsx';
import { BigPlay, CtrlButton, SeekBar } from './controls.jsx';
import { contain, cueAt, cutCue, joinedCues, joinedParts, moment, partAt, pipRect } from './split.js';
import { fixDuration, layer, stageStyle, toggleFullscreen, useFullscreen, useStage } from './Video.jsx';

const INITIAL = { split: null, caption: null, isQuestion: false, asker: '', hasFace: false, second: 0, playing: false, started: false };
const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

export const JointPlayer = forwardRef(function JointPlayer({ answers, video, onCurrent }, ref) {
  const parts = useMemo(() => joinedParts(answers, video.chapters), [answers, video.chapters]);
  const cues = useMemo(() => joinedCues(parts), [parts]);
  const total = parts.at(-1)?.end ?? 0;
  const { ref: stageRef, wide } = useStage();
  const fullscreen = useFullscreen(stageRef);
  const videoRef = useRef(null);
  const foxCanvas = useRef(null);
  const cropCanvas = useRef(null);
  const faceSlot = useRef(null);
  const clipSlot = useRef(null);
  const fillRef = useRef(null);
  const latest = useRef(null);
  latest.current = { parts, cues, total, onCurrent };
  const [view, setView] = useState(INITIAL);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [controls, setControls] = useState(true);
  const [scrub, setScrub] = useState(null); // where a finger is on the timeline
  const [muted, setMuted] = useState(false);
  const rt = useRef(null); // what changes every frame, kept outside React; set up once mounted

  const tick = useCallback(() => {
    const r = rt.current;
    const v = videoRef.current;
    if (!r || !v) return;
    const { parts, cues, total, onCurrent } = latest.current;
    const t = v.currentTime;
    const m = moment(parts, t, r.started);
    let cue = r.started && r.captionsOn ? cueAt(cues, t) : null;
    if (!cue && m.cut && r.captionsOn && m.part.captions) cue = cutCue(m.part, t);
    // Each asker's video, clip and lip sync loads while the answer before it plays.
    const i = parts.indexOf(m.part);
    for (const p of [parts[i], parts[i + 1]]) {
      if (!r.started || !p) continue;
      if (p.q.askerVideo) face(p.q).preload = 'auto';
      if (p.q.broll?.video) clip(p.q).preload = 'auto';
      lipSync(p.q);
    }
    showFace(m.asking?.askerVideo ? face(m.asking) : null, m.at);
    showClip(m.cut ? clip(m.part.q) : null, m.clipAt);
    r.level = m.asking && r.analyser && !v.paused ? 0.6 * r.level + 0.4 * loudness() : 0.85 * r.level;
    const hasFace = Boolean(r.shownFace && r.pictured.has(r.shownFace));
    if (m.asking && !hasFace) {
      const sync = lipSync(m.asking);
      r.fox.draw(sync ? (sync.frames[Math.floor(m.at * sync.fps)] ?? [0, 1, 0]) : [r.level, 1, r.level], blinkAt(m.asking.id, m.at), m.at);
    }
    if (m.cut) drawCrop();
    if (m.asking) r.asker = askerLabel(m.asking); // kept while the half fades out
    if (fillRef.current) fillRef.current.style.width = `${total ? (100 * t) / total : 0}%`;
    // Which answer is playing, for the summary under the player: nothing before it's played.
    const current = v.paused && t < 0.05 ? null : (m.part?.q.id ?? null);
    if (current !== r.current) {
      r.current = current;
      onCurrent?.(current);
    }
    const next = { split: m.split, caption: cue?.[2] ?? null, isQuestion: Boolean(m.asking), asker: r.asker, hasFace, second: Math.floor(t), playing: !v.paused, started: r.started };
    setView((prev) => (same(prev, next) ? prev : next));
  }, []);

  // The askers' videos, for questions asked on camera, muted: their sound is in the joined video.
  function face(q) {
    const r = rt.current;
    if (!r.faces.has(q.id)) r.faces.set(q.id, sideVideo(q.askerVideo, 'contain', '#111'));
    return r.faces.get(q.id);
  }
  // The answers' b-roll clips, muted: the expert's sound carries on under them.
  function clip(q) {
    const r = rt.current;
    if (!r.clips.has(q.id)) r.clips.set(q.id, sideVideo(q.broll.video, 'cover', '#000'));
    return r.clips.get(q.id);
  }
  // Kept in step with the joined video: it plays and pauses with it, and seeks once it's drifted.
  function follow(el, at, limit) {
    const v = videoRef.current;
    if (Number.isFinite(el.duration) && Math.abs(el.currentTime - at) > limit) el.currentTime = Math.min(Math.max(0, at), el.duration);
    if (v.paused) el.pause();
    else if (el.paused && !el.ended) el.play().catch(() => {}); // it may end a moment before its part does
  }
  function showFace(f, at) {
    const r = rt.current;
    if (f !== r.shownFace) {
      r.shownFace?.pause();
      faceSlot.current?.replaceChildren(...(f ? [f] : []));
      r.shownFace = f;
    }
    if (!f) return;
    follow(f, at, 0.3);
    // The fox stands in until the video has a picture of this moment, rather than an empty black
    // box or a first frame that then jumps. Once shown it stays, even while it seeks.
    if (f.readyState >= 2 && !f.seeking && Math.abs(f.currentTime - at) <= 0.3) r.pictured.add(f);
  }
  function showClip(c, at) {
    const r = rt.current;
    if (c !== r.shownClip) {
      r.shownClip?.pause();
      clipSlot.current?.replaceChildren(...(c ? [c] : []));
      r.shownClip = c;
    }
    if (c) follow(c, at, 0.25);
  }

  // The expert, cropped from the corner of the joined video's picture where the server put them.
  function drawCrop() {
    const c = cropCanvas.current;
    const v = videoRef.current;
    if (!c || !v.videoWidth || v.readyState < 2) return;
    const w = Math.round(c.clientWidth * devicePixelRatio);
    const h = Math.round(c.clientHeight * devicePixelRatio);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) [c.width, c.height] = [w, h];
    const ctx = c.getContext('2d');
    const [sx, sy, sw, sh] = pipRect(v.videoWidth);
    const [dx, dy, dw, dh] = contain(sw, sh, w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(v, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  // The questions' lip sync, for the fox. Each loads while the answer before it plays.
  function lipSync(q) {
    const r = rt.current;
    if (q.lipSync && !r.lipSyncs.has(q.id)) {
      r.lipSyncs.set(q.id, null);
      api('GET', q.lipSync).then((res) => r.lipSyncs.set(q.id, res.lipSync), () => {});
    }
    return r.lipSyncs.get(q.id) ?? null;
  }

  // Until a question's lip sync has loaded, or if it has none, the fox's mouth follows how loud the
  // question is. That means routing the video's sound through Web Audio, which browsers only allow
  // starting from a tap, as play() always is. If it can't be set up, the mouth stays shut.
  function listen() {
    const r = rt.current;
    if (r.analyser != null || typeof AudioContext === 'undefined') return;
    r.analyser = false;
    try {
      const ctx = (r.audio = new AudioContext());
      const node = ctx.createAnalyser();
      node.fftSize = 1024;
      ctx.createMediaElementSource(videoRef.current).connect(node);
      node.connect(ctx.destination);
      ctx.resume().catch(() => {});
      r.samples = new Uint8Array(node.fftSize);
      r.analyser = node;
    } catch {
      // the video plays as it is
    }
  }
  function loudness() {
    const r = rt.current;
    r.analyser.getByteTimeDomainData(r.samples);
    let sum = 0;
    for (const v of r.samples) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / r.samples.length) * 5); // speech is around 0.05-0.2 RMS
  }

  const begin = () => {
    rt.current.started = true;
  };
  const seek = (t) => {
    begin();
    videoRef.current.currentTime = Math.max(0, Math.min(t, latest.current.total));
    tick();
  };
  const play = (t) => {
    if (t != null) seek(t);
    listen();
    videoRef.current.play().catch(() => {});
  };
  const toggle = () => (videoRef.current.paused || videoRef.current.ended ? play() : videoRef.current.pause());
  useImperativeHandle(ref, () => ({ play, parts }), [parts]);

  useEffect(() => {
    const v = videoRef.current;
    rt.current = { started: false, captionsOn: true, analyser: null, samples: null, level: 0, audio: null, faces: new Map(), clips: new Map(), lipSyncs: new Map(), shownFace: null, shownClip: null, pictured: new WeakSet(), fox: fox(foxCanvas.current), asker: '', current: undefined, frame: 0 };
    const r = rt.current;
    const unfix = fixDuration(v, { firstFrame: true });
    // Every frame while it plays, so the split and the captions land on time; timeupdate is only a
    // few times a second.
    const loop = () => {
      tick();
      r.frame = v.paused ? 0 : requestAnimationFrame(loop);
    };
    const onPlay = () => {
      begin();
      cancelAnimationFrame(r.frame);
      loop();
    };
    const onVolume = () => setMuted(v.muted);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', tick);
    v.addEventListener('volumechange', onVolume);
    ['timeupdate', 'seeked', 'loadedmetadata'].forEach((type) => v.addEventListener(type, tick));
    return () => {
      unfix();
      cancelAnimationFrame(r.frame);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', tick);
      v.removeEventListener('volumechange', onVolume);
      ['timeupdate', 'seeked', 'loadedmetadata'].forEach((type) => v.removeEventListener(type, tick));
      for (const el of [...r.faces.values(), ...r.clips.values()]) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      r.audio?.close().catch(() => {});
    };
  }, [tick]);

  useEffect(() => {
    rt.current.captionsOn = captionsOn;
    tick();
  }, [captionsOn, tick, parts, wide]);

  // The controls get out of the way while it plays, until the stage is tapped.
  const controlsShown = !view.started || !view.playing || controls || scrub != null;
  useEffect(() => {
    if (!view.playing || !controls || scrub != null) return;
    const timer = setTimeout(() => setControls(false), 2500);
    return () => clearTimeout(timer);
  }, [view.playing, controls, scrub]);

  const ccHidden = parts.length > 0 && parts.every((p) => p.captions); // they're all in the picture
  const mainSlot = view.split ? 'bottom' : 'center';
  // Captions sit above the controls where the main picture reaches down to them.
  const captionLift = controlsShown && (view.split || wide) ? 92 : 12;
  const scrubPart = scrub != null ? partAt(parts, scrub) : null;

  return (
    <div
      ref={stageRef}
      className="split-stage"
      style={stageStyle}
      onClick={() => {
        if (!rt.current.started) return play();
        setControls(!controlsShown);
      }}
    >
      <video ref={videoRef} src={video.src} preload="metadata" playsInline style={layer(mainSlot, wide)} />
      <div ref={clipSlot} style={layer('bottom', wide, { shown: view.split === 'broll', z: 1, extra: { background: '#000' } })} />
      <div style={layer('top', wide, { shown: Boolean(view.split), z: 2, extra: { background: view.split === 'broll' ? '#000' : '#f3f3f3', overflow: 'hidden' } })} aria-hidden="true">
        <div style={{ position: 'absolute', inset: 0, display: view.split === 'broll' ? 'none' : 'block' }}>
          <canvas ref={foxCanvas} style={{ position: 'absolute', top: 0, left: '50%', height: '100%', aspectRatio: '627 / 470', transform: 'translateX(-50%)', visibility: view.hasFace ? 'hidden' : 'visible' }} />
          <div ref={faceSlot} style={{ position: 'absolute', inset: 0, display: view.hasFace ? 'block' : 'none' }} />
        </div>
        <canvas ref={cropCanvas} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: view.split === 'broll' ? 'block' : 'none' }} />
        {view.split !== 'broll' && view.asker ? <span style={askerPill}>{view.asker}</span> : null}
      </div>
      <div style={layer(mainSlot, wide, { z: 3, extra: { display: 'flex', alignItems: 'flex-end', justifyContent: 'center', boxSizing: 'border-box', padding: `0 6% ${captionLift}px` } })} aria-hidden="true">
        {view.caption ? <span style={{ ...captionStyle, fontStyle: view.isQuestion ? 'italic' : 'normal' }}>{view.caption}</span> : null}
      </div>
      {!view.started ? <BigPlay label="Play" onPress={() => play()} /> : controlsShown ? <BigPlay playing={view.playing} onPress={toggle} /> : null}
      <div style={{ ...controlsBar, opacity: controlsShown ? 1 : 0, pointerEvents: controlsShown ? 'auto' : 'none' }} onClick={(e) => e.stopPropagation()}>
        {scrubPart ? (
          <div style={tip}>
            {fmtDuration(scrub)} · {parts.indexOf(scrubPart) + 1}. {scrubPart.q.summary?.question ?? scrubPart.q.body}
          </div>
        ) : null}
        <div style={{ display: 'flex', padding: '0 10px' }}>
          <SeekBar total={total} value={view.second} fillRef={fillRef} ticks={parts.slice(1).map((p) => (total ? p.start / total : 0))} onSeek={seek} onScrub={setScrub} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 4px' }}>
          <CtrlButton label={view.playing ? 'Pause' : 'Play'} onPress={toggle}>
            <Icon name={view.playing ? 'pause' : 'play'} color="#fff" />
          </CtrlButton>
          <span style={timeStyle}>
            {fmtDuration(view.second)} / {fmtDuration(total)}
          </span>
          <span style={{ flex: 1 }} />
          {ccHidden ? null : (
            <CtrlButton label="Captions" pressed={captionsOn} onPress={() => setCaptionsOn(!captionsOn)}>
              CC
            </CtrlButton>
          )}
          <CtrlButton label={muted ? 'Unmute' : 'Mute'} onPress={() => (videoRef.current.muted = !videoRef.current.muted)}>
            <Icon name={muted ? 'muted' : 'sound'} color="#fff" />
          </CtrlButton>
          <CtrlButton label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onPress={() => toggleFullscreen(stageRef.current, videoRef.current)}>
            <Icon name={fullscreen ? 'exitFullscreen' : 'fullscreen'} color="#fff" />
          </CtrlButton>
        </div>
      </div>
    </div>
  );
});

// A muted video that plays alongside the joined one, in one of the halves.
function sideVideo(src, fit, background) {
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.setAttribute('playsinline', '');
  el.preload = 'metadata';
  el.src = src;
  Object.assign(el.style, { display: 'block', width: '100%', height: '100%', objectFit: fit, background });
  fixDuration(el);
  return el;
}

const askerPill = { position: 'absolute', left: 10, bottom: 10, padding: '3px 11px', borderRadius: 999, background: 'rgba(0,0,0,0.5)', color: '#fff', font: "600 13px/1.4 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", whiteSpace: 'nowrap' };
const captionStyle = { padding: '2px 9px', borderRadius: 5, background: 'rgba(0,0,0,0.62)', color: '#fff', font: "600 15px/1.35 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", textAlign: 'center', textWrap: 'balance', transition: 'none' };
const controlsBar = { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 5, paddingTop: 28, paddingBottom: 2, background: 'linear-gradient(transparent, rgba(0,0,0,0.7))', transition: 'opacity 0.25s' };
const timeStyle = { color: '#fff', fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
const tip = { margin: '0 12px 2px', padding: '4px 9px', borderRadius: 6, background: 'rgba(0,0,0,0.85)', color: '#fff', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
