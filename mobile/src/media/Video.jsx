// Video and sound. React Native has no video on the web, so these are the browser's own <video>
// and <audio> elements, inside React Native views.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { slot } from './split.js';

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

// A <video>, playing inline (not jumping to fullscreen on iPhones), with its duration fixed.
// `muted` is set on the element itself: React's attribute doesn't stop it playing sound everywhere.
export const Video = forwardRef(function Video({ src, firstFrame = true, muted = false, style, children, ...props }, ref) {
  const el = useRef(null);
  useImperativeHandle(ref, () => el.current, []);
  useEffect(() => fixDuration(el.current, { firstFrame }), [src, firstFrame]);
  useEffect(() => {
    el.current.muted = muted;
  }, [muted]);
  return (
    <video ref={el} src={src} playsInline preload="metadata" style={{ display: 'block', width: '100%', ...style }} {...props}>
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

// The stage the split screen plays on: two 16:9 pictures tall, so a split never changes its size
// (and the page under it doesn't jump). `wide` is whether it's wider than tall, as it is in
// fullscreen on a phone turned sideways, where the halves go side by side.
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

export const stageStyle = { position: 'relative', width: '100%', aspectRatio: '8 / 9', maxHeight: '78vh', overflow: 'hidden', background: '#000', borderRadius: 18, userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation' };

// A layer of the stage in `name`'s place (see slot()), moving there smoothly; hidden ones fade out.
export function layer(name, wide, { shown = true, fit = 'contain', z = 0, extra = null } = {}) {
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

// Prefer MP4 (plays in every browser, and phones record it) where the browser can record it; Firefox records WebM.
export const RECORDING_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const MAX_RECORDING_SECS = 600;
// Same preference for spoken questions; Firefox records Ogg or WebM.
export const AUDIO_RECORDING_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg'];
export const MAX_QUESTION_SECS = 90;
