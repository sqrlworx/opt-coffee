// The published answers as one video: the takes joined end to end on the server (src/video.js),
// as the page's jointPlayer plays them, but split screen instead of picture in picture, on an
// upright stage that each picture fills.
//
// The expert has the top half whenever it splits. While a question asked on camera is played (the
// start of each take, up to its `answerStart`), the asker's video is under them, kept in step with
// the question. While an answer's split-screen b-roll plays, the clip is, in step. The rest of the
// time the joined video has the whole stage, full-screen b-roll included, which the server cuts
// into it. The halves crop the expert and the asker to frame their faces, where the server found
// them (the chapters' expertFocus and askerFocus). Any other question doesn't split: the fox says
// it in a bubble at the top left, over the expert, with the asker's name under it, where the page
// shows the asker's picture.
//
// It has its own controls (a video's own would shrink into one half), which fade while it plays
// until the stage is tapped. It plays the joined video's copy for phones where there is one: upright,
// with full-screen b-roll but not split-screen b-roll cut in, and with its burned-in captions at the
// bottom of the expert's half (see write_mobile_ass in src/finish/captions.py). A video joined before
// there was one plays as the page has it, the expert cropped from the corner where the server put
// them over the b-roll. Captions that aren't burned in are drawn there too, just above the split, or
// low on the joined video while it plays alone. So are burned-in ones while b-roll covers them, in a
// video joined before there were copies for phones.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { blinkAt, FOX, fox } from '../../../public/fox.js';
import { api } from '../api.js';
import { askerLabel, fmtDuration } from '../format.js';
import { Icon } from '../ui/icons.jsx';
import { BigPlay, CtrlButton, SeekBar } from './controls.jsx';
import { cover, cueAt, cutCue, focusPosition, joinedCues, joinedParts, moment, partAt, pipRect } from './split.js';
import { fixDuration, layer, stageStyle, toggleFullscreen, useFullscreen, useStage } from './Video.jsx';

// How far down the stage a lone picture's captions come, where the phone's 3:4 copy burns them in
// (src/finish/captions.py).
const LOW = 0.8;
// Until an asker's video has a picture to show, the fox stands in, on the bottom edge of their half
// where its picture is cut off, as big as fits. The half and the bubble are the colour of the
// picture's own background (public/fox.webp), so whatever room is left around it doesn't show.
const FOX_BACKDROP = '#f9f9f9';

const INITIAL = { split: null, caption: null, isQuestion: false, bubble: false, asker: '', hasFace: false, focus: null, pip: false, second: 0, playing: false, started: false };
const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

export const JointPlayer = forwardRef(function JointPlayer({ answers, video, onCurrent }, ref) {
  const parts = useMemo(() => joinedParts(answers, video.chapters), [answers, video.chapters]);
  const cues = useMemo(() => joinedCues(parts), [parts]);
  const total = parts.at(-1)?.end ?? 0;
  const { ref: stageRef, wide } = useStage();
  const fullscreen = useFullscreen(stageRef);
  const videoRef = useRef(null);
  const foxCanvas = useRef(null);
  const bubbleCanvas = useRef(null);
  const cropCanvas = useRef(null);
  const faceSlot = useRef(null);
  const clipSlot = useRef(null);
  const fillRef = useRef(null);
  const latest = useRef(null);
  latest.current = { parts, cues, total, onCurrent, mobileCopy: Boolean(video.mobileSrc) };
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
    const { parts, cues, total, onCurrent, mobileCopy } = latest.current;
    const t = v.currentTime;
    const m = moment(parts, t, r.started);
    let cue = r.started && r.captionsOn ? cueAt(cues, t) : null;
    if (!cue && m.cut && r.captionsOn && m.part.captions && !mobileCopy) cue = cutCue(m.part, t);
    // Each asker's video, clip and lip sync loads while the answer before it plays.
    const i = parts.indexOf(m.part);
    for (const p of [parts[i], parts[i + 1]]) {
      if (!r.started || !p) continue;
      if (p.q.askerVideo) face(p).preload = 'auto';
      if (p.q.broll?.video && !p.q.broll.full) clip(p.q).preload = 'auto';
      lipSync(p.q);
    }
    showFace(m.asking?.askerVideo ? face(m.part) : null, m.at);
    showClip(m.cut ? clip(m.part.q) : null, m.clipAt);
    r.level = m.asking && r.analyser && !v.paused ? 0.6 * r.level + 0.4 * loudness() : 0.85 * r.level;
    const hasFace = Boolean(r.shownFace && r.pictured.has(r.shownFace));
    const bubble = Boolean(m.asking && !m.asking.askerVideo);
    if (m.asking && !hasFace) {
      const sync = lipSync(m.asking);
      (bubble ? r.bubbleFox : r.fox).draw(sync ? (sync.frames[Math.floor(m.at * sync.fps)] ?? [0, 1, 0]) : [r.level, 1, r.level], blinkAt(m.asking.id, m.at), m.at);
    }
    const pip = v.videoWidth > v.videoHeight; // the page's video, with the b-roll cut in
    if (m.cut && pip) drawCrop();
    if (m.asking) r.asker = askerLabel(m.asking); // kept while the half or the bubble fades out
    if (fillRef.current) fillRef.current.style.width = `${total ? (100 * t) / total : 0}%`;
    // Which answer is playing, for the summary under the player: nothing before it's played.
    const current = v.paused && t < 0.05 ? null : (m.part?.q.id ?? null);
    if (current !== r.current) {
      r.current = current;
      onCurrent?.(current);
    }
    const next = { split: m.split, caption: cue?.[2] ?? null, isQuestion: Boolean(m.asking), bubble, asker: r.asker, hasFace, focus: m.part?.expertFocus ?? null, pip, second: Math.floor(t), playing: !v.paused, started: r.started };
    setView((prev) => (same(prev, next) ? prev : next));
  }, []);

  // The askers' videos, for questions asked on camera, muted: their sound is in the joined video.
  // Each is cropped to frame the asker's face, where the server found it.
  function face({ q, askerFocus }) {
    const r = rt.current;
    if (!r.faces.has(q.id)) {
      const el = sideVideo(q.askerVideo, 'cover', '#111');
      el.style.objectPosition = focusPosition(askerFocus);
      r.faces.set(q.id, el);
    }
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

  // In the page's video (one joined before the phone had a copy of its own), the expert is cropped
  // into the top half from the corner of the picture where the server put them over the b-roll.
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
    const [cx, cy, cw, ch] = cover(sw, sh, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(v, sx + cx, sy + cy, cw, ch, 0, 0, w, h);
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
    rt.current = { started: false, captionsOn: true, analyser: null, samples: null, level: 0, audio: null, faces: new Map(), clips: new Map(), lipSyncs: new Map(), shownFace: null, shownClip: null, pictured: new WeakSet(), fox: fox(foxCanvas.current), bubbleFox: fox(bubbleCanvas.current, FOX.bubble), asker: '', current: undefined, frame: 0 };
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
  // Alone, the joined video has the whole stage, but all of it shows on a phone turned sideways:
  // filling that, an upright picture would be cut down to a band across the face.
  const mainFit = wide && !view.split ? 'contain' : 'cover';
  // Captions sit just above the split, rising clear of the play button while it's shown, or low on a
  // lone picture. Sideways they go at the bottom of the left half, or of the stage, above the controls.
  const captionLow = view.split || wide ? null : { height: `${100 * LOW}%` };
  const captionShift = wide ? `${controlsShown ? -92 : -12}px` : !view.split ? '0px' : controlsShown ? '-46px' : '-10px';
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
      <video ref={videoRef} src={video.mobileSrc ?? video.src} preload="metadata" playsInline style={layer(view.split ? 'top' : 'full', wide, { fit: mainFit, extra: { objectPosition: view.split ? focusPosition(view.focus) : 'center' } })} />
      <div ref={clipSlot} style={layer('bottom', wide, { shown: view.split === 'broll', z: 1, extra: { background: '#000' } })} />
      <div style={layer('bottom', wide, { shown: view.split === 'question', z: 1, extra: { background: FOX_BACKDROP, overflow: 'hidden' } })} aria-hidden="true">
        <div style={{ position: 'absolute', inset: 0, containerType: 'size' }}>
          <canvas ref={foxCanvas} style={{ position: 'absolute', bottom: 0, left: '50%', width: 'min(100cqw, 100cqh * 627 / 470)', aspectRatio: '627 / 470', transform: 'translateX(-50%)', visibility: view.hasFace ? 'hidden' : 'visible' }} />
          <div ref={faceSlot} style={{ position: 'absolute', inset: 0, display: view.hasFace ? 'block' : 'none' }} />
        </div>
        {view.asker ? <span style={{ ...askerPill, bottom: controlsShown ? 90 : 10 }}>{view.asker}</span> : null}
      </div>
      {/* Faded rather than taken out, so it has a size to draw at the moment the cut comes up, even paused. */}
      <canvas ref={cropCanvas} aria-hidden="true" style={layer('top', wide, { shown: view.split === 'broll' && view.pip, z: 2 })} />
      <div style={layer(view.split ? 'top' : 'full', wide, { z: 3, extra: { display: 'flex', alignItems: 'flex-end', justifyContent: 'center', boxSizing: 'border-box', padding: '0 6%', ...captionLow } })} aria-hidden="true">
        {view.caption ? <span style={{ ...captionStyle, fontStyle: view.isQuestion ? 'italic' : 'normal', transform: `translateY(${captionShift})` }}>{view.caption}</span> : null}
      </div>
      {/* Faded rather than taken out, so the fox has a size to draw at the moment it comes in. */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 4, containerType: 'size', pointerEvents: 'none' }} aria-hidden="true">
        <div style={{ ...bubbleGroup, opacity: view.bubble ? 1 : 0, transform: view.bubble ? 'none' : 'scale(0.85)' }}>
          <div style={bubbleCircle}>
            <canvas ref={bubbleCanvas} style={{ display: 'block', width: '100%', height: '100%', borderRadius: '50%' }} />
          </div>
          {view.asker ? <span style={bubbleName}>{view.asker}</span> : null}
        </div>
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

const pill = { padding: '3px 11px', borderRadius: 999, background: 'rgba(0,0,0,0.5)', color: '#fff', font: "600 13px/1.4 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", whiteSpace: 'nowrap' };
// At the bottom left of the asker's half, risen clear of the controls while they're shown.
const askerPill = { ...pill, position: 'absolute', left: 10, transition: 'bottom 0.25s' };
// The fox's bubble, at the top left: two-fifths of the stage's width, or less of a sideways one's
// height, where it sits beside the picture. The asker's name is centred under it: a name wider than
// the bubble moves it in a little, and a much longer one is cut short. It grows from the corner as it
// comes in, as the page's picture of the asker does.
const BUBBLE = 'min(40cqw, 30cqh)';
const bubbleGroup = { position: 'absolute', top: 12, left: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, transformOrigin: 'top left', transition: 'opacity 0.3s, transform 0.3s' };
const bubbleCircle = { width: BUBBLE, aspectRatio: '1', borderRadius: '50%', overflow: 'hidden', background: FOX_BACKDROP, boxShadow: '0 4px 16px rgba(0,0,0,0.4), 0 0 0 2px rgba(255,255,255,0.85)' };
const bubbleName = { ...pill, boxSizing: 'border-box', maxWidth: `calc(${BUBBLE} + 64px)`, overflow: 'hidden', textOverflow: 'ellipsis' };
const captionStyle = { padding: '2px 9px', borderRadius: 5, background: 'rgba(0,0,0,0.62)', color: '#fff', font: "600 15px/1.35 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", textAlign: 'center', textWrap: 'balance', transition: 'transform 0.3s' };
const controlsBar = { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 5, paddingTop: 28, paddingBottom: 2, background: 'linear-gradient(transparent, rgba(0,0,0,0.7))', transition: 'opacity 0.25s' };
const timeStyle = { color: '#fff', fontSize: 13, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
const tip = { margin: '0 12px 2px', padding: '4px 9px', borderRadius: 6, background: 'rgba(0,0,0,0.85)', color: '#fff', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif' };
