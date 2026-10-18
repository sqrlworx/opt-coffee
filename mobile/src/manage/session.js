// Recording answers in a session, as the page does (recordingSession in public/app.js): the expert
// starts at any queued question and answers them back to back without stopping the camera. Each
// question is played into the recording (and their headphones), then they answer; Save keeps that
// take as the question's answer and plays the next question. Each take is its own recording, so it
// uploads while they carry on. This is the session itself; Studio.jsx shows it, split screen.
import { askerLabel } from '../format.js';
import { MAX_RECORDING_SECS, RECORDING_TYPES } from '../media/Video.jsx';

// `order` is the question ids to answer, from the one they started at; `questions` maps ids to
// questions. Kept takes go to `keep(qid, take)` once the browser has finished them; `finishing(n)`
// hears how many are still being finished (publishing waits for them). `changed()` hears whenever
// there's something new to show, and `closed(answered)` when it ends.
export function createSession({ order, camera, questions, keep, finishing, toast, changed, closed }) {
  // The recording's sound is the microphone plus the question being played. The question also
  // goes to the speakers so the expert hears it; the microphone doesn't, to avoid feedback.
  const { sampleRate } = camera.getAudioTracks()[0].getSettings();
  const ctx = new AudioContext(sampleRate ? { sampleRate } : {});
  const mix = ctx.createMediaStreamDestination();
  let sound = mix.stream.getAudioTracks();
  try {
    ctx.createMediaStreamSource(camera).connect(mix);
  } catch {
    // Some browsers can't mix a microphone at a different sample rate. Record it as it is: the
    // expert still hears the question, but it's only in the recording if the mic picks it up.
    sound = camera.getAudioTracks();
  }
  const stream = new MediaStream([...camera.getVideoTracks(), ...sound]);
  const mimeType = RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';

  // What Studio shows. `take` is the current question's recording: { qid, loading, recorder,
  // source, started, answering, answerStart, exiting, keep }. `clip` is the asker's video while a
  // question asked on camera plays, `clipShown` once it has a picture (one slow to load would be
  // an empty black box until then).
  const state = { order, index: 0, take: null, answered: new Set(), clip: null, clipShown: false, closed: false, label: '' };
  let slot = null; // where the asker's video goes: the top half of the split screen

  // Questions' audio, downloaded and decoded before their take starts recording, so the question
  // plays the moment recording begins instead of after a pause while it downloads.
  const sounds = new Map(); // audio URL -> Promise<AudioBuffer | null>
  function questionSound(qid) {
    const url = questions.get(qid).audio;
    if (!url) return Promise.resolve(null);
    if (!sounds.has(url)) {
      const decoded = fetch(url, { signal: AbortSignal.timeout(20_000) })
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(res.statusText))))
        .then((data) => ctx.decodeAudioData(data))
        .catch(() => null); // they can still read it off the screen
      sounds.set(url, decoded);
    }
    return sounds.get(url);
  }

  // A question asked on camera also plays its video, muted, in the top half while its sound plays.
  // It loads ahead like the sound; one that's slow to load shows up when it can.
  const clips = new Map(); // video URL -> Promise<HTMLVideoElement | null>
  function questionClip(qid) {
    const url = questions.get(qid).askerVideo;
    if (!url) return Promise.resolve(null);
    if (!clips.has(url)) {
      const clip = document.createElement('video');
      clip.muted = true; // its sound is the question's audio, played (and recorded) with it
      clip.playsInline = true;
      clip.setAttribute('playsinline', '');
      clip.preload = 'auto';
      clip.src = url;
      Object.assign(clip.style, { display: 'block', width: '100%', height: '100%', objectFit: 'contain', background: '#111' });
      clip.addEventListener('playing', () => {
        if (state.clip !== clip) return;
        state.clipShown = true;
        changed();
      });
      clips.set(url, new Promise((resolve) => {
        const timer = setTimeout(() => resolve(clip), 10_000);
        clip.addEventListener('canplay', () => (clearTimeout(timer), resolve(clip)), { once: true });
        clip.addEventListener('error', () => (clearTimeout(timer), resolve(null)), { once: true });
      }));
    }
    return clips.get(url);
  }
  function showClip(clip) {
    state.clip = clip;
    state.clipShown = Boolean(clip && clip.readyState >= 2);
    state.label = clip ? askerLabel(questions.get(state.take.qid)) : state.label; // kept while the half closes
    slot?.replaceChildren(...(clip ? [clip] : []));
    changed();
  }
  function hideClip() {
    state.clip?.pause();
    showClip(null);
  }

  const timer = setInterval(() => {
    const { take } = state;
    if (!take || take.loading || take.exiting) return;
    if ((performance.now() - take.started) / 1000 >= MAX_RECORDING_SECS) {
      toast(`Answers are limited to ${MAX_RECORDING_SECS / 60} minutes each, so recording stopped`, 'error');
      endTake(true);
      close();
    }
  }, 250);

  // Records one question: plays it, then the expert answers. Recording waits until the question's
  // audio is ready (usually it already is: it's fetched while the previous question is answered).
  async function startTake() {
    const qid = order[state.index];
    const current = { qid, loading: true, recorder: null, source: null, started: 0, answering: false, answerStart: null, exiting: false, keep: false };
    state.take = current;
    changed();
    const [buffer, clip] = await Promise.all([questionSound(qid), questionClip(qid)]);
    if (state.take !== current) return; // skipped or exited while it loaded
    if (state.index + 1 < order.length) {
      questionSound(order[state.index + 1]);
      questionClip(order[state.index + 1]);
    }
    const chunks = [];
    const recorder = (current.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 }));
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      if (!current.keep) return;
      finishing(-1);
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
      keep(qid, { blob, url: URL.createObjectURL(blob), answerStart: current.answerStart });
    };
    const answering = (played) => {
      if (state.take !== current || current.answering) return;
      current.answering = true;
      hideClip();
      if (played) current.answerStart = (performance.now() - current.started) / 1000;
      changed();
    };
    ctx.resume().catch(() => {});
    current.loading = false;
    recorder.start(1000);
    current.started = performance.now();
    if (buffer) {
      const source = (current.source = ctx.createBufferSource());
      source.buffer = buffer;
      source.connect(mix);
      source.connect(ctx.destination);
      source.onended = () => answering(true);
      source.start();
      if (clip) {
        clip.currentTime = 0;
        showClip(clip);
        clip.play().catch(() => {});
      }
    } else {
      answering(false); // no audio (yet): the question is on screen to read out
    }
    changed();
  }

  // Ends the current take, keeping it as the question's answer only if `keepIt` and they've started answering.
  function endTake(keepIt) {
    const { take } = state;
    hideClip();
    if (take.source) {
      take.source.onended = null;
      take.source.stop();
    }
    take.keep = keepIt && take.answering;
    if (take.keep) {
      state.answered.add(take.qid);
      finishing(1);
    }
    take.recorder?.stop(); // a take still loading hasn't started recording
    state.take = null;
  }

  function advance() {
    state.index += 1;
    if (state.index < order.length) startTake();
    else close();
  }

  // Exiting asks whether to keep the answer in progress; recording pauses while they decide.
  // Before they've started answering there's nothing to keep, so it just exits.
  function exit() {
    if (!state.take?.answering) return close();
    state.take.recorder.pause();
    state.take.exiting = performance.now();
    changed();
  }

  function keepRecording() {
    const { take } = state;
    take.started += performance.now() - take.exiting; // the pause isn't part of the take
    take.exiting = false;
    take.recorder.resume();
    changed();
  }

  function close() {
    if (state.closed) return;
    state.closed = true;
    clearInterval(timer);
    if (state.take) endTake(false); // leaving the page mid-take
    camera.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
    for (const pending of clips.values()) pending.then((clip) => clip && (clip.pause(), clip.removeAttribute('src'), clip.load()));
    if (state.answered.size) toast(`${state.answered.size} answer${state.answered.size === 1 ? '' : 's'} recorded`, 'success');
    closed(state.answered);
  }

  return {
    state,
    camera,
    // Starts recording, with `el` as the top half for askers' videos.
    start(el) {
      slot = el;
      startTake();
    },
    next: () => state.take && (endTake(true), advance()),
    skip: () => state.take && (endTake(false), advance()),
    restart: () => state.take && (endTake(false), startTake()),
    exit,
    keepRecording,
    finishExit: (keepIt) => (endTake(keepIt), close()),
    close,
  };
}
