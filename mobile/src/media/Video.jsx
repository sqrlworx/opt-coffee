// Video and sound. React Native has no video on the web, so these are the browser's own <video>
// and <audio> elements, inside React Native views.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { cover, slot } from './split.js';

// Browser recordings don't store their duration up front, so the player reports Infinity and can't
// seek. Seeking far past the end makes the browser find the real duration. `firstFrame` then seeks
// a hair past the start: with only metadata preloaded, phones (Safari always) show a blank video
// until it's played, and seeking makes them decode and show the first frame. Returns a cleanup.
export function fixDuration(media, { firstFrame = false } = {}) {
  const start = firstFrame ? 0.001 : 0;
  const reset = () => (media.currentTime = start);
  const onMeta = () => {
    if (media.duration !== Infinity) {
      if (start && media.currentTime === 0) media.currentTime = start;
      return;
    }
    media.addEventListener('timeupdate', reset, { once: true });
    media.currentTime = 1e101;
  };
  media.addEventListener('loadedmetadata', onMeta);
  return () => {
    media.removeEventListener('loadedmetadata', onMeta);
    media.removeEventListener('timeupdate', reset);
  };
}

// Props for a <video> that tell `set` its picture's shape, width / height: once it loads, and again
// whenever that changes (a phone's camera turned sideways).
export function onShape(set) {
  const update = (e) => {
    const { videoWidth: w, videoHeight: h } = e.currentTarget;
    if (w && h) set(w / h);
  };
  return { onLoadedMetadata: update, onResize: update };
}

// A video's box in its picture's shape: full width, except that an upright one (as the app records)
// stops at 60% of the screen's height, centred, rather than running down the page.
export function shaped(aspect) {
  if (aspect >= 1) return { width: '100%', aspectRatio: String(aspect) };
  return { width: `min(100%, 60vh * ${aspect})`, aspectRatio: String(aspect), alignSelf: 'center' };
}

// A <video>, playing inline (not jumping to fullscreen on iPhones), with its duration fixed, in its
// picture's shape (16:9 until that's known). `muted` is set on the element itself: React's
// attribute doesn't stop it playing sound everywhere.
export const Video = forwardRef(function Video({ src, firstFrame = true, muted = false, style, children, ...props }, ref) {
  const el = useRef(null);
  const [aspect, setAspect] = useState(16 / 9);
  useImperativeHandle(ref, () => el.current, []);
  useEffect(() => fixDuration(el.current, { firstFrame }), [src, firstFrame]);
  useEffect(() => {
    el.current.muted = muted;
  }, [muted]);
  return (
    <video ref={el} src={src} playsInline preload="metadata" {...onShape(setAspect)} style={{ display: 'block', ...shaped(aspect), ...style }} {...props}>
      {children}
    </video>
  );
});

export const AudioPlayer = forwardRef(function AudioPlayer({ src }, ref) {
  const el = useRef(null);
  useImperativeHandle(ref, () => el.current, []);
  useEffect(() => fixDuration(el.current), [src]);
  return <audio ref={el} src={src} controls preload="metadata" style={{ display: 'block', width: '100%', height: 44 }} />;
});

// Whether a media element is playing, kept up to date.
export function usePlaying(ref) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    media.addEventListener('play', on);
    media.addEventListener('pause', off);
    media.addEventListener('ended', off);
    return () => {
      media.removeEventListener('play', on);
      media.removeEventListener('pause', off);
      media.removeEventListener('ended', off);
    };
  });
  return playing;
}

// A media element's current time, as it plays (a few times a second) or seeks.
export function useMediaTime(ref) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    const update = () => setT(media.currentTime);
    ['timeupdate', 'seeked', 'loadedmetadata'].forEach((type) => media.addEventListener(type, update));
    return () => ['timeupdate', 'seeked', 'loadedmetadata'].forEach((type) => media.removeEventListener(type, update));
  });
  return t;
}

// The stage the split screen plays on: upright, 9:16, as phones film, so each half is 9:8 (STAGE,
// HALF). A split never changes its size, so the page under it doesn't jump. `wide` is whether it's
// wider than tall, as it is in fullscreen on a phone turned sideways, where the halves go side by side.
export function useStage() {
  const ref = useRef(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWide(el.clientWidth > el.clientHeight * 1.2));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, wide };
}

export const STAGE = 9 / 16;
export const HALF = 9 / 8;

// At most 78% of the screen tall: narrower rather than another shape.
export const stageStyle = { position: 'relative', width: `min(100%, 78vh * ${STAGE})`, alignSelf: 'center', aspectRatio: String(STAGE), overflow: 'hidden', background: '#000', borderRadius: 18, userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation' };

// A layer of the stage in `name`'s place (see slot()), moving there smoothly; hidden ones fade out.
// A video fills its place, cropped to it.
export function layer(name, wide, { shown = true, fit = 'cover', z = 0, extra = null } = {}) {
  return {
    position: 'absolute',
    ...slot(name, wide),
    objectFit: fit,
    opacity: shown ? 1 : 0,
    zIndex: z,
    transition: 'top 0.3s, left 0.3s, width 0.3s, height 0.3s, opacity 0.3s',
    pointerEvents: 'none',
    ...extra,
  };
}

// B-roll is shown whole, as the joined video has it (cutawayFilter in src/video.js), on a blurred,
// darker copy of itself where its shape leaves room: `video` drawn small on `canvas`, which goes,
// with backStyle, in a layer that keeps its blurred edges in (overflow hidden).
export function drawBack(canvas, video) {
  const [w, h] = [Math.round(canvas.clientWidth / 4), Math.round(canvas.clientHeight / 4)];
  if (!w || !h || !video.videoWidth || video.readyState < 2) return;
  if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
  const [x, y, cw, ch] = cover(video.videoWidth, video.videoHeight, w, h);
  canvas.getContext('2d').drawImage(video, x, y, cw, ch, 0, 0, w, h);
}

export const backStyle = { display: 'block', width: '100%', height: '100%', filter: 'blur(12px) brightness(0.9) saturate(0.7)', transform: 'scale(1.1)' };

// Fullscreen for the stage, so the split and the controls stay on. iPhones can only put a video
// itself fullscreen, without them.
export function toggleFullscreen(stage, video) {
  if (document.fullscreenElement ?? document.webkitFullscreenElement) (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
  else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
  else video.webkitEnterFullscreen?.();
}

export function useFullscreen(ref) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const update = () => setOn((document.fullscreenElement ?? document.webkitFullscreenElement) === ref.current);
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
    };
  }, [ref]);
  return on;
}

// The front camera. An answer is recorded 3:4, the shape of a phone's camera, so that it can fill
// the whole stage (9:16) or either half of it (9:8) with little cropped off either way. A question
// asked on camera is only ever shown in the top half, so it's recorded in that shape. Chrome crops
// these out of a webcam that's wider than tall: a 1080p webcam records 810x1080 and 1215x1080.
// Asking for more than 1080 tall makes Chrome pick a 4K webcam's 4K mode, and MediaRecorder then
// records the crop at full size, whatever size the track reports.
export const ANSWER_CAMERA = { facingMode: 'user', aspectRatio: { ideal: 3 / 4 }, height: { ideal: 1080 } };
export const QUESTION_CAMERA = { facingMode: 'user', aspectRatio: { ideal: HALF }, height: { ideal: 1080 } };

// Prefer MP4 (plays in every browser, and phones record it) where the browser can record it; Firefox records WebM.
export const RECORDING_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const MAX_RECORDING_SECS = 600;
// Same preference for spoken questions; Firefox records Ogg or WebM.
export const AUDIO_RECORDING_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg'];
export const MAX_QUESTION_SECS = 90;
