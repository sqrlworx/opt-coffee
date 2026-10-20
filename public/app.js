// off hours — single-page client. No framework: a tiny h() helper and hash routing.

import { fox, blinkAt } from './fox.js';

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
let me = null;
let devLogin = false; // server has the dev user switcher enabled
let devSession = false; // and it logged `me` in, not their password
let speech = false; // server can transcribe recordings and read text aloud
let brollOn = false; // experts can add b-roll to their answers: upload it
let makesBroll = false; // and have it made from a description
let brollModel = null; // by this model, which films it
let voices = []; // the voices typed questions can be read aloud in: [{ id, name, accent, sample }]
let myVoice = null; // the one the user last picked (or the default)
let devUsers = null;
let pageCleanup = null; // set by a page that holds resources (like the camera) to release on navigation

// ---------- utilities ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// Like el.replaceChildren(), but flattens arrays and skips null/false like h() does.
function setChildren(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
}

// `body` is sent as JSON, or as-is if it's a Blob (a recorded video). `timeout` (ms) gives up on
// a request that hangs.
async function api(method, path, body, { timeout } = {}) {
  const blob = body instanceof Blob;
  const res = await fetch(path, {
    method,
    headers: blob ? { 'Content-Type': body.type.split(';')[0] } : body ? { 'Content-Type': 'application/json' } : {},
    body: blob ? body : body ? JSON.stringify(body) : undefined,
    signal: timeout ? AbortSignal.timeout(timeout) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Like api() with a Blob, for a file the user picked: tells `progress` how much of it has gone, from
// 0 to 1, which fetch can't. Aborting `signal` stops sending it (rejecting with an AbortError).
function sendFile(method, path, file, { progress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => e.lengthComputable && progress?.(e.loaded / e.total);
    xhr.upload.onload = () => progress?.(1);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.response ?? {});
      const err = new Error(xhr.response?.error ?? `Request failed (${xhr.status})`);
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Couldn't send it. Check your connection and try again."));
    xhr.onabort = () => reject(new DOMException('Stopped', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

function toast(message, kind = 'info') {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 3500);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relative(iso) {
  const diff = (new Date(iso) - Date.now()) / 1000;
  const units = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return diff >= 0 ? 'in a moment' : 'just now';
}

function fmtDuration(secs) {
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// The time left until `deadline`, as 2d 05h 09m 30s, ticking down each second while it's on the page.
function countdown(deadline) {
  const end = new Date(deadline).getTime();
  const el = h('dd', { class: 'countdown', role: 'timer', title: `Closes ${fmtDate(deadline)}` });
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    if (!left) return setChildren(el, 'Closed');
    const units = [[Math.floor(left / 86400), 'd'], [Math.floor(left / 3600) % 24, 'h'], [Math.floor(left / 60) % 60, 'm'], [left % 60, 's']];
    // From the first unit that isn't zero; the ones after it keep two digits, so it doesn't jump about.
    const shown = units.slice(units.findIndex(([n]) => n > 0));
    setChildren(el, shown.map(([n, unit], i) => [i ? ' ' : null, i ? String(n).padStart(2, '0') : n, h('span', { class: 'cd-unit' }, unit)]));
    setTimeout(() => el.isConnected && tick(), (end - Date.now()) % 1000 || 1000); // when the seconds change
  };
  tick();
  return el;
}

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function requireLogin() {
  toast('Log in to do that');
  go(`#/login?next=${encodeURIComponent(location.hash)}`);
}

// Wraps an async click handler: disables the button while it runs and surfaces errors.
function action(fn) {
  return async (event) => {
    const btn = event?.currentTarget;
    if (btn) btn.disabled = true;
    try {
      await fn(event);
    } catch (err) {
      if (err.status === 401) requireLogin();
      else toast(err.message, 'error');
    } finally {
      if (btn?.isConnected) btn.disabled = false;
    }
  };
}

// ---------- shared components ----------

function userLink(user) {
  return h('a', { href: `#/u/${user.username}`, class: 'user-link' }, user.displayName);
}

function statusBadge(oh) {
  if (oh.status === 'open') return h('span', { class: 'badge badge-open' }, `Taking questions · closes ${relative(oh.questionsDeadline)}`);
  if (oh.status === 'closed') return h('span', { class: 'badge badge-closed' }, `Closed · answers ${fmtDay(oh.answersExpectedAt)}`);
  if (oh.processing) return h('span', { class: 'badge badge-closed' }, 'Published · preparing the video');
  return h('span', { class: 'badge badge-published' }, `Answered ${relative(oh.publishedAt)}`);
}

function topicChip(oh) {
  return oh.topic ? h('span', { class: 'chip' }, oh.topic) : h('span', { class: 'chip chip-muted' }, 'Open topic');
}

function subscribeButton({ type, id, subscribed, label }) {
  const btn = h('button', { class: subscribed ? 'btn btn-secondary' : 'btn btn-outline' }, subscribed ? `✓ Subscribed${label ? ` to ${label}` : ''}` : `Subscribe${label ? ` to ${label}` : ''}`);
  btn.addEventListener(
    'click',
    action(async () => {
      if (!me) return requireLogin();
      await api(subscribed ? 'DELETE' : 'POST', '/api/subscriptions', { type, id });
      subscribed = !subscribed;
      btn.className = subscribed ? 'btn btn-secondary' : 'btn btn-outline';
      btn.textContent = subscribed ? `✓ Subscribed${label ? ` to ${label}` : ''}` : `Subscribe${label ? ` to ${label}` : ''}`;
    }),
  );
  return btn;
}

// The expert's name in an office hour's byline. Hovering it, or focusing it from the keyboard, shows
// a card about them with a button to subscribe to them. Without a mouse the name still goes to their
// profile, which has the button too.
function expertCard(oh) {
  const { expert } = oh;
  return h(
    'span',
    { class: 'person-card' },
    userLink(expert),
    h(
      'span',
      { class: 'person-pop' },
      h('span', { class: 'person-pop-name' }, expert.displayName),
      expert.bio ? h('span', { class: 'person-pop-bio' }, expert.bio) : null,
      subscribeButton({ type: 'expert', id: expert.id, subscribed: oh.subscribedToExpert }),
    ),
  );
}

// When questions close: a countdown in the last week, the date before that, and once they've
// closed, when that was (publishing closes them too).
function questionsFact(oh) {
  if (oh.status !== 'open') {
    const closed = [oh.closedAt, oh.questionsDeadline].filter(Boolean).sort()[0];
    return h('div', {}, h('dt', {}, 'Questions closed'), h('dd', {}, fmtDate(closed)));
  }
  const soon = new Date(oh.questionsDeadline) - Date.now() <= 7 * 86400_000;
  return h('div', {}, h('dt', {}, 'Questions open'), soon ? countdown(oh.questionsDeadline) : h('dd', {}, `until ${fmtDate(oh.questionsDeadline)}`));
}

function questionMeta(q) {
  const parts = [];
  if (q.askedWith === 'audio') {
    const how = q.askerVideo ? 'Asked on camera' : 'Asked out loud';
    parts.push(h('span', { class: 'tag' }, q.audioTranscript?.edited ? `${how} · transcript edited` : how));
  }
  if (q.source === 'moderator') parts.push(h('span', { class: 'tag tag-mod' }, '✦ Suggested by moderator'));
  else if (q.anonymous) parts.push(h('span', { class: 'tag' }, 'Anonymous'));
  else if (q.author) parts.push(userLink(q.author));
  if (q.mine) parts.push(h('span', { class: 'tag tag-you' }, q.anonymous ? 'you (hidden)' : 'you'));
  return h('div', { class: 'q-meta' }, parts);
}

function voteButton(q, { enabled }) {
  const btn = h('button', { class: `vote${q.voted ? ' voted' : ''}`, title: enabled ? (q.voted ? 'Remove +1' : '+1 this question') : 'Voting is closed', disabled: !enabled }, h('span', { class: 'vote-arrow' }, '▲'), h('span', { class: 'vote-count' }, q.votes));
  btn.addEventListener(
    'click',
    action(async () => {
      if (!me) return requireLogin();
      const res = await api(q.voted ? 'DELETE' : 'POST', `/api/questions/${q.id}/vote`);
      Object.assign(q, res);
      btn.classList.toggle('voted', q.voted);
      btn.querySelector('.vote-count').textContent = q.votes;
    }),
  );
  return btn;
}

function questionRow(q, { canVote }) {
  return h('li', { class: 'q-row' }, voteButton(q, { enabled: canVote }), h('div', { class: 'q-main' }, questionText(q), questionMeta(q)));
}

function askForm(oh, onAsked) {
  if (!me) {
    return h('div', { class: 'ask ask-login' }, h('a', { href: `#/login?next=${encodeURIComponent(`#/oh/${oh.id}`)}` }, 'Log in'), ' to ask a question.');
  }
  const textarea = h('textarea', { rows: 2, maxlength: 500, placeholder: `Ask ${oh.expert.displayName} something…`, required: true });
  const anon = oh.allowAnonymous ? h('input', { type: 'checkbox' }) : null;
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Ask');
  // Asking out loud or on camera, when the server can transcribe. Typed questions are read aloud instead.
  const anonymous = () => anon?.checked ?? false;
  const recorders = speech ? { audio: spokenQuestion(oh, anonymous, onAsked), video: spokenQuestion(oh, anonymous, onAsked, { camera: true }) } : {};
  const recorderList = Object.values(recorders);
  const voice = voices.length > 1 ? voicePicker() : null;
  const anonNote = h('p', { class: 'hint', hidden: true });
  let mode = 'text';
  const modeButton = (value, label) => h('button', { type: 'button', class: 'ask-mode', 'data-mode': value, 'aria-pressed': String(value === mode), onclick: () => setMode(value) }, label);
  const modes = speech ? h('div', { class: 'ask-modes', role: 'group', 'aria-label': 'How to ask' }, modeButton('text', 'Type'), modeButton('audio', 'Speak'), modeButton('video', 'Video')) : null;

  function showAnonNote() {
    anonNote.hidden = !(mode !== 'text' && anon?.checked);
    anonNote.textContent = mode === 'video'
      ? 'Your name is hidden, but your video is public, and people may recognize you.'
      : 'Your name is hidden, but your recording is public, and people may recognize your voice.';
  }

  function setMode(value) {
    if (value === mode) return;
    if (recorders[mode]?.busy() && !confirm("Discard the recording you haven't sent?")) return;
    recorders[mode]?.close();
    mode = value;
    modes.querySelectorAll('.ask-mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    textarea.hidden = submit.hidden = mode !== 'text';
    textarea.required = mode === 'text';
    if (voice) {
      voice.el.hidden = mode !== 'text';
      voice.stop();
    }
    for (const [kind, recorder] of Object.entries(recorders)) recorder.el.hidden = kind !== mode;
    showAnonNote();
  }
  anon?.addEventListener('change', showAnonNote);
  if (speech) {
    recorderList.forEach((r) => (r.el.hidden = true));
    // Let go of the microphone and camera on navigation, and stop a voice being previewed.
    pageCleanup = () => {
      recorderList.forEach((r) => r.close());
      voice?.stop();
    };
    window.onbeforeunload = () => (recorderList.some((r) => r.busy()) ? true : undefined);
  }

  const form = h(
    'form',
    { class: 'ask' },
    modes,
    textarea,
    voice?.el,
    recorderList.map((r) => r.el),
    h('div', { class: 'ask-actions' }, anon ? h('label', { class: 'check' }, anon, ' Ask anonymously') : h('span', { class: 'muted small' }, 'Your name will be shown with your question.'), submit),
    anonNote,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (mode !== 'text') return;
    action(async () => {
      const { question } = await api('POST', `/api/office-hours/${oh.id}/questions`, { body: textarea.value, anonymous: anon?.checked ?? false, voice: voice?.value() });
      textarea.value = '';
      voice?.stop();
      if (voice) myVoice = voice.value(); // the server keeps it as their voice for next time
      toast("Question submitted — you'll be notified when it's answered", 'success');
      onAsked?.(question);
    })({ currentTarget: submit });
  });
  return form;
}

// Picks the voice a typed question is read aloud in from a dropdown, starting from the one the asker
// picked last time. The button beside it plays a short sample of the voice picked.
function voicePicker() {
  let chosen = voices.some((v) => v.id === myVoice) ? myVoice : voices[0].id;
  let playing = null; // the sample being played
  const PLAY = '▶';
  const voice = () => voices.find((v) => v.id === chosen);
  const option = (v) => h('option', { value: v.id, selected: v.id === chosen }, v.name);
  const accents = [...new Set(voices.map((v) => v.accent).filter(Boolean))];
  // Grouped by accent, so the closed dropdown needs only the voice's name.
  const select = h('select', { id: 'ask-voice' }, voices.filter((v) => !v.accent).map(option), accents.map((accent) => h('optgroup', { label: accent }, voices.filter((v) => v.accent === accent).map(option))));
  const play = h('button', { type: 'button', class: 'voice-play', 'aria-pressed': 'false' }, PLAY);
  const label = () => {
    play.title = `Hear ${voice().name}`;
    play.setAttribute('aria-label', play.title);
  };

  function stop() {
    if (!playing) return;
    playing.pause();
    playing = null;
    play.textContent = PLAY;
    play.setAttribute('aria-pressed', 'false');
  }

  function preview() {
    if (playing) return stop(); // a second click stops it
    const v = voice();
    const audio = new Audio(v.sample);
    playing = audio;
    play.textContent = '…'; // the first preview of a voice takes a moment to make
    play.setAttribute('aria-pressed', 'true');
    audio.addEventListener('playing', () => playing === audio && (play.textContent = '■'));
    audio.addEventListener('ended', () => playing === audio && stop());
    audio.addEventListener('error', () => {
      if (playing !== audio) return;
      stop();
      toast(`Couldn't play ${v.name}'s voice right now`, 'error');
    });
    audio.play().catch(() => {}); // a failed load is reported by the error event
  }

  select.addEventListener('change', () => {
    chosen = select.value;
    stop(); // it was the last voice's sample
    label();
  });
  play.addEventListener('click', preview);
  label();
  const el = h('div', { class: 'ask-voice' }, h('label', { for: 'ask-voice' }, 'Read aloud to the expert in'), h('span', { class: 'ask-voice-pick' }, select, play));
  return { el, value: () => chosen, stop };
}

// Records a question out loud, or on camera with `camera`. When the asker stops, the recording is
// transcribed, and they can play it back and correct the transcript (it becomes the question's
// text) before asking.
function spokenQuestion(oh, anonymous, onAsked, { camera = false } = {}) {
  const box = h('div', { class: 'spoken' });
  let stream = null; // microphone, and camera
  let recorder = null;
  let take = null; // { blob, url } of a finished recording not yet asked
  let draft = null; // the server's transcribed copy of `take`: { id, cues }
  let timer = null;
  const buttons = (...children) => h('div', { class: 'row gap-sm wrap' }, children);

  function stopMic() {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function close() {
    if (recorder?.state === 'recording') {
      recorder.onstop = null;
      recorder.stop();
    }
    recorder = null;
    stopMic();
    if (take) URL.revokeObjectURL(take.url);
    take = null;
    if (draft) api('DELETE', `/api/recordings/${draft.id}`).catch(() => {}); // the server would drop it after a day anyway
    draft = null;
    showIdle();
  }

  function showIdle() {
    setChildren(
      box,
      buttons(
        h('button', { type: 'button', class: 'btn btn-primary', onclick: action(record) }, '● Record your question'),
        h('span', { class: 'muted small' }, `Up to ${MAX_QUESTION_SECS} seconds. You'll check the transcript before asking.`),
      ),
    );
  }

  // The take as it was recorded, to play back while checking the transcript.
  const playback = (url) => (camera ? fixDuration(h('video', { class: 'q-take', src: url, controls: true, preload: 'metadata', playsinline: true }), { firstFrame: true }) : audioPlayer(url));

  async function record() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error(`This browser can't record ${camera ? 'video' : 'audio'}. Try a recent Chrome, Firefox or Safari.`);
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: camera ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false });
    } catch (err) {
      stopMic();
      if (err.name === 'NotAllowedError') throw new Error(camera ? 'Allow camera and microphone access to ask on camera.' : 'Allow microphone access to ask out loud.');
      throw new Error(`Couldn't start the ${camera ? 'camera' : 'microphone'}: ${err.message}`);
    }
    const mimeType = (camera ? RECORDING_TYPES : AUDIO_RECORDING_TYPES).find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const chunks = [];
    const rec = (recorder = new MediaRecorder(stream, camera ? { mimeType, videoBitsPerSecond: 1_500_000 } : { mimeType }));
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stopMic();
      recorder = null;
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType });
      take = { blob, url: URL.createObjectURL(blob) };
      action(transcribe)();
    };
    rec.start(1000);

    const started = Date.now();
    const clock = h('span', {}, '0:00');
    const stop = () => rec.state === 'recording' && rec.stop();
    timer = setInterval(() => {
      const secs = (Date.now() - started) / 1000;
      clock.textContent = fmtDuration(secs);
      if (secs >= MAX_QUESTION_SECS) stop();
    }, 250);
    let preview = null;
    if (camera) {
      preview = h('video', { class: 'q-take live', autoplay: true, playsinline: true });
      preview.muted = true; // don't play the mic back into the room
      preview.srcObject = stream;
    }
    setChildren(box, preview, buttons(h('span', { class: 'rec-pill' }, '● REC ', clock), h('button', { type: 'button', class: 'btn btn-primary', onclick: stop }, '■ Stop'), h('button', { type: 'button', class: 'btn btn-outline', onclick: close }, 'Cancel')));
  }

  const rerecord = action(async () => (close(), record()));

  async function transcribe() {
    const current = take;
    setChildren(box, playback(current.url), buttons(h('span', { class: 'muted small' }, 'Transcribing your recording…')));
    try {
      const { recording } = await api('POST', `/api/office-hours/${oh.id}/recordings`, current.blob);
      if (take !== current) return api('DELETE', `/api/recordings/${recording.id}`).catch(() => {}); // discarded meanwhile
      draft = recording;
      showReview();
    } catch (err) {
      // Keep the recording so a failure doesn't lose it.
      if (take === current) {
        setChildren(
          box,
          playback(current.url),
          buttons(
            h('button', { type: 'button', class: 'btn btn-primary', onclick: action(transcribe) }, 'Try again'),
            h('button', { type: 'button', class: 'btn btn-outline', onclick: rerecord }, 'Re-record'),
            h('button', { type: 'button', class: 'link-btn', onclick: close }, 'Discard'),
          ),
        );
      }
      throw err;
    }
  }

  function showReview() {
    const lines = cueLines(draft.cues);
    setChildren(
      box,
      playback(take.url),
      h(
        'div',
        { class: 'cue-editor' },
        h('p', { class: 'hint' }, "Check the transcript: it's your question's text. Fix anything that was misheard. Each line is one subtitle and keeps its timing; clear a line to remove it."),
        lines.el,
      ),
      buttons(
        h('button', { type: 'button', class: 'btn btn-primary', onclick: action(() => ask(lines.values())) }, 'Ask'),
        h('button', { type: 'button', class: 'btn btn-outline', onclick: rerecord }, 'Re-record'),
        h('button', { type: 'button', class: 'link-btn', onclick: close }, 'Discard'),
      ),
    );
  }

  async function ask(cues) {
    try {
      const { question } = await api('POST', `/api/office-hours/${oh.id}/questions`, { recording: draft.id, cues, anonymous: anonymous() });
      draft = null; // it's the question's recording now
      close();
      toast("Question submitted — you'll be notified when it's answered", 'success');
      onAsked?.(question);
    } catch (err) {
      if (err.status === 404) {
        // The draft expired on the server; the recording is still here to transcribe again.
        draft = null;
        await transcribe();
        return;
      }
      throw err; // stays on the review, with the corrections, to try again
    }
  }

  showIdle();
  return { el: box, close, busy: () => recorder?.state === 'recording' || take != null };
}

// Browser recordings don't store their duration up front, so the player reports Infinity and
// can't seek. Seeking far past the end makes the browser find the real duration.
// `firstFrame` then seeks a hair past the start: with only metadata preloaded, some browsers
// (Safari always, Chrome sometimes) show a blank video until it's played, and seeking makes them
// decode and show the first frame.
function fixDuration(media, { firstFrame = false } = {}) {
  const start = firstFrame ? 0.001 : 0;
  media.addEventListener('loadedmetadata', () => {
    if (media.duration !== Infinity) {
      if (start && media.currentTime === 0) media.currentTime = start;
      return;
    }
    media.addEventListener('timeupdate', () => (media.currentTime = start), { once: true });
    media.currentTime = 1e101;
  });
  return media;
}

// Whether a media element's time is moving: playing, and neither seeking nor waiting for data, as
// it does when it's sent somewhere it hasn't loaded yet. A video kept in step with it holds still
// meanwhile, rather than playing on and being sent back.
function advancing(media) {
  return !media.paused && !media.seeking && media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
}

// Marks a video `upright` once its picture turns out taller than wide, as the mobile app records,
// so the styles made for 16:9 don't crop it.
function markUpright(video) {
  const mark = () => video.videoWidth && video.classList.toggle('upright', video.videoHeight > video.videoWidth);
  video.addEventListener('loadedmetadata', mark);
  video.addEventListener('resize', mark);
  return video;
}

// `transcript` adds its captions as subtitles once they're ready.
function videoPlayer(src, transcript) {
  const video = markUpright(fixDuration(h('video', { class: 'answer-video', src, controls: true, preload: 'metadata', playsinline: true }), { firstFrame: true }));
  addCaptions(video, transcript);
  return video;
}

// An answer's video with its b-roll cut in, as it is in the joined video (src/video.js): from
// `broll.start` for `broll.length` seconds, split screen, the answer filling the left half and all of
// the b-roll in the right, fading in together over the answer, or, with `broll.full`, full screen,
// all of the b-roll in the frame and the answer moving to a picture at the top left. Either way the
// b-roll sits on a blurred copy of itself where its shape leaves room. It's muted, since the
// answer's sound carries on, and kept in step with the answer. Full-screen b-roll the expert let run
// past the end of the answer plays on once the answer has ended, the answer's picture fading out of
// the corner, as the joined video has it: the timeline runs to its end, and the clip keeps the time
// while it plays alone. The video's own controls would be covered, or shrink into that picture, so it
// gets these instead: play, the time, and a timeline marking where the b-roll is. Without b-roll it's
// the video as it was. Called again for the same video, it updates the same frame with `broll`.
function brollView(video, broll) {
  if (video.brollView) return video.brollView.update(broll);
  const el = h('div', { class: 'broll-view' }, video);
  const clip = h('video', { class: 'broll-clip', preload: 'auto', playsinline: true, 'aria-hidden': 'true' });
  clip.muted = true;
  // The left half of a split, drawn from the answer as it plays, cropped to fill it rather than fitted,
  // as the joined video has it; and the blurred copy the b-roll sits on, drawn small from the clip,
  // in a box that keeps its blurred edges in. They're faded rather than taken out, so they have a
  // size to draw at the moment the cut comes up, even paused.
  const half = h('canvas', { class: 'broll-half', 'aria-hidden': 'true' });
  const blur = h('canvas');
  const back = h('div', { class: 'broll-back', 'aria-hidden': 'true' }, blur);
  const playBtn = h('button', { type: 'button', class: 'jp-btn', 'aria-label': 'Play', onclick: () => toggle() }, icon('play'));
  const time = h('span', { class: 'jp-time' });
  const fill = h('span', { class: 'jp-fill' });
  const span = h('span', { class: 'broll-span', title: 'B-roll' });
  const bar = h('div', { class: 'jp-bar', role: 'slider', tabindex: '0', 'aria-label': 'Seek' }, fill, span);
  const controls = h('div', { class: 'broll-controls' }, playBtn, time, bar);
  let current = null;
  let over = false; // the answer has ended, and its b-roll plays on past it

  const length = () => (Number.isFinite(video.duration) ? video.duration : 0);
  const runsPast = () => Boolean(current && length() && current.start + current.length > length() + 0.05);
  const total = () => (runsPast() ? current.start + current.length : length());
  const now = () => (over ? current.start + clip.currentTime : video.currentTime);
  const playing = () => (over ? !clip.paused : !video.paused);
  const toggle = () => {
    if (!over) return video.paused || video.ended ? video.play().catch(() => {}) : video.pause();
    if (!clip.paused) return clip.pause();
    if (clip.ended || now() >= total() - 0.05) {
      seek(0); // at the end of the b-roll: from the start again
      return video.play().catch(() => {});
    }
    clip.play().catch(() => {});
  };
  function seek(t) {
    t = Math.max(0, Math.min(t, total() || t));
    const wasPlaying = playing();
    if (runsPast() && t >= length()) {
      // Past the end of the answer: it waits at its end, under the b-roll, which plays on from there.
      over = true;
      video.pause();
      video.currentTime = length();
      clip.currentTime = t - current.start;
      if (wasPlaying) clip.play().catch(() => {});
    } else {
      if (over) {
        over = false;
        clip.pause();
        if (wasPlaying) video.play().catch(() => {});
      }
      video.currentTime = t;
    }
    tick();
  }
  function tick() {
    if (!current) return;
    if (over && !runsPast()) over = false;
    const t = now();
    const cut = over || (t >= current.start && t < current.start + current.length);
    el.classList.toggle('is-cut', cut);
    el.classList.toggle('is-over', over);
    if (cut) {
      if (!over) {
        const at = t - current.start;
        if (Number.isFinite(clip.duration) && Math.abs(clip.currentTime - at) > 0.25) clip.currentTime = Math.min(at, clip.duration);
        if (!advancing(video)) clip.pause();
        else if (clip.paused && !clip.ended) clip.play().catch(() => {});
      }
      drawFill(blur, clip, 0.5, 0.25);
      if (!current.full) drawFill(half, video, 0.6, devicePixelRatio);
    } else {
      clip.pause();
    }
    const all = total();
    fill.style.width = `${all ? (100 * Math.min(t, all)) / all : 0}%`;
    span.style.left = `${all ? (100 * current.start) / all : 0}%`;
    span.style.width = `${all ? (100 * current.length) / all : 0}%`;
    time.textContent = `${fmtDuration(t)} / ${fmtDuration(all)}`;
  }
  // `source` cropped to fill `canvas`, at `scale` pixels to each of its CSS pixels: the middle
  // across, and `down` of the way down. The answer in the left half has more cropped off the top than
  // the bottom, as the joined video has it without a face to go by (FOCUS in src/video.js).
  function drawFill(canvas, source, down, scale) {
    const [w, ht] = [Math.round(canvas.clientWidth * scale), Math.round(canvas.clientHeight * scale)];
    const [vw, vh] = [source.videoWidth, source.videoHeight];
    if (!w || !ht || !vw || source.readyState < 2) return;
    if (canvas.width !== w || canvas.height !== ht) [canvas.width, canvas.height] = [w, ht];
    const fit = Math.max(w / vw, ht / vh);
    const [sw, sh] = [w / fit, ht / fit];
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, (vw - sw) / 2, (vh - sh) * down, sw, sh, 0, 0, w, ht);
  }
  // Every frame while it plays, so the cut lands on time; timeupdate is only a few times a second.
  let frame = 0;
  const loop = () => {
    tick();
    frame = playing() ? requestAnimationFrame(loop) : 0;
  };
  function showPlaying() {
    const on = playing();
    el.classList.toggle('playing', on);
    setChildren(playBtn, icon(on ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    cancelAnimationFrame(frame);
    loop();
  }
  video.addEventListener('play', showPlaying);
  video.addEventListener('pause', () => {
    // The answer has ended with b-roll still to play: it plays on, alone.
    if (video.ended && runsPast() && !over) {
      over = true;
      clip.play().catch(() => {});
    }
    showPlaying();
  });
  ['play', 'pause'].forEach((type) => clip.addEventListener(type, () => over && showPlaying()));
  ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange'].forEach((type) => video.addEventListener(type, tick));
  // A paused clip shows the frame it was sent to only once it has it: the blurred copy follows then.
  ['seeked', 'loadeddata'].forEach((type) => clip.addEventListener(type, tick));
  video.addEventListener('click', () => current && toggle());
  clip.addEventListener('click', toggle);

  const timeAt = (e) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total();
  };
  let scrubbing = false;
  bar.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    bar.setPointerCapture(e.pointerId);
    seek(timeAt(e));
  });
  bar.addEventListener('pointermove', (e) => scrubbing && seek(timeAt(e)));
  bar.addEventListener('pointerup', () => (scrubbing = false));
  bar.addEventListener('pointercancel', () => (scrubbing = false));
  bar.addEventListener('keydown', (e) => {
    const keys = { ArrowLeft: -5, ArrowRight: 5 };
    if (e.key in keys) seek(now() + keys[e.key]);
    else if (e.key === ' ' || e.key === 'k') toggle();
    else return;
    e.preventDefault();
  });

  const view = {
    el,
    update(next) {
      current = next?.video ? next : null;
      el.classList.toggle('has-broll', Boolean(current));
      el.classList.toggle('is-full', Boolean(current?.full));
      video.controls = !current;
      if (current) {
        if (clip.getAttribute('src') !== current.video) clip.src = current.video;
        if (!clip.isConnected) el.append(half, back, clip, controls);
        tick();
      } else {
        over = false;
        el.classList.remove('is-cut', 'is-over');
        clip.pause();
        half.remove();
        back.remove();
        clip.remove();
        controls.remove();
      }
      return view;
    },
  };
  video.brollView = view;
  return view.update(broll);
}

function audioPlayer(src) {
  return fixDuration(h('audio', { class: 'q-audio', src, controls: true, preload: 'metadata' }));
}

// Adds the transcript's subtitles to a video, or swaps in corrected ones (keeping them on if they were showing).
function addCaptions(video, transcript) {
  const current = video.querySelector('track');
  if (!transcript?.captions || current?.getAttribute('src') === transcript.captions) return;
  const showing = current?.track.mode === 'showing';
  current?.remove();
  const track = h('track', { kind: 'subtitles', src: transcript.captions, srclang: 'en', label: 'English' });
  video.append(track);
  if (showing) track.track.mode = 'showing';
}

function editButton(onclick) {
  return h('button', { type: 'button', class: 'link-btn small', onclick }, 'Edit transcript');
}

// Corrects transcription mistakes line by line. Each line is one subtitle and keeps its timing;
// clearing a line removes it. `save(lines)` stores the corrections and resolves with the result,
// which goes to `done` (null if cancelled).
function transcriptEditor(cues, { save, done }) {
  const lines = cueLines(cues);
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary btn-small' }, 'Save transcript');
  saveBtn.addEventListener('click', action(async () => {
    const result = await save(lines.values());
    toast('Transcript saved', 'success');
    done(result);
  }));
  return h(
    'div',
    { class: 'cue-editor' },
    h('p', { class: 'hint' }, 'Fix anything the transcription got wrong. Each line is one subtitle, so it keeps its timing. Clear a line to remove it.'),
    lines.el,
    h('div', { class: 'row gap-sm' }, saveBtn, h('button', { type: 'button', class: 'btn btn-small', onclick: () => done(null) }, 'Cancel')),
  );
}

// One input per transcript cue, labelled with its start time.
function cueLines(cues) {
  const inputs = cues.map(([, , text]) => h('input', { value: text, maxlength: 300, 'aria-label': 'Transcript line' }));
  setTimeout(() => inputs[0]?.focus());
  return {
    el: cues.map(([start], i) => h('label', { class: 'cue-edit' }, h('span', { class: 'cue-time' }, fmtDuration(start)), inputs[i])),
    values: () => inputs.map((input) => input.value),
  };
}

function captionsLink(url) {
  return h('a', { class: 'small', href: url, download: '' }, 'Download captions (.vtt)');
}

// Speech is processed in the background. Re-fetches a question every few seconds until
// `done(question)` holds, then calls `then(question)`. Stops once `el` leaves the page.
function watchQuestion(id, el, done, then) {
  const tick = async () => {
    if (!el.isConnected) return;
    try {
      const { question } = await api('GET', `/api/questions/${id}`, null, { timeout: 10_000 });
      if (done(question)) return then(question);
    } catch {
      // failed or hung: try again on the next tick
    }
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

// Transcript cues as text that follows playback: the cue being spoken is highlighted, and
// clicking a cue plays from there.
function syncedCues(media, cues, cls) {
  const spans = cues.map(([start, , text]) =>
    h('span', { class: 'cue', title: `Play from ${fmtDuration(start)}`, onclick: () => ((media.currentTime = start), media.play().catch(() => {})) }, text),
  );
  media.addEventListener('timeupdate', () => {
    const t = media.currentTime;
    cues.forEach(([start, end], i) => spans[i].classList.toggle('active', t >= start && t < end));
  });
  return h('p', { class: cls }, spans.flatMap((span, i) => (i ? [' ', span] : [span])));
}

// An answer's transcript, under its video. A pending one is watched until it's ready, and then
// its captions are added to the video too. `pick` finds this answer's transcript in a re-fetched
// question; `onUpdate` hears about the change.
// `editable` lets the expert correct it.
function answerTranscript(video, transcript, opts) {
  const { questionId, pick, onUpdate, editable = false, open = false } = opts;
  if (!transcript) return null;
  const replace = (el, next, extra = {}) => {
    onUpdate?.(next);
    addCaptions(video, next);
    el.replaceWith(answerTranscript(video, next, { ...opts, ...extra }) ?? '');
  };
  if (transcript.status === 'pending') {
    const el = h('p', { class: 'muted small' }, 'Transcribing… captions and a transcript will appear here.');
    watchQuestion(questionId, el, (q) => pick(q)?.status !== 'pending', (q) => replace(el, pick(q)));
    return el;
  }
  if (transcript.status === 'failed') return h('p', { class: 'muted small' }, "This answer couldn't be transcribed.");
  if (!transcript.cues.length) return h('p', { class: 'muted small' }, 'No speech was detected in this answer.');
  const panel = h(
    'details',
    { class: 'transcript', open },
    h('summary', {}, 'Transcript', transcript.edited ? h('span', { class: 'muted' }, ' · edited') : null),
    syncedCues(video, transcript.cues, 'transcript-text'),
    h(
      'div',
      { class: 'row gap-sm wrap' },
      captionsLink(transcript.captions),
      editable
        ? editButton(() => {
            const editor = transcriptEditor(transcript.cues, {
              save: async (lines) => (await api('PUT', `/api/questions/${questionId}/answer-transcript`, { cues: lines })).transcript,
              done: (next) => replace(editor, next ?? transcript, { open: true }),
            });
            panel.replaceWith(editor);
          })
        : null,
    ),
  );
  return panel;
}

// A small button after a question's text that plays `media`: the asker's recording, or the typed
// text read aloud, or the video of a question asked on camera. It shows while the question is
// hovered (see styles.css). An <audio> goes inside it; a video is shown under the text by
// questionText.
function playButton(q, media) {
  const video = media.tagName === 'VIDEO';
  const label = video ? 'Watch the question as it was asked' : q.askedWith === 'audio' ? 'Play the question as it was asked' : 'Listen to the question';
  const face = h('span', { class: 'play-face' });
  const btn = h('button', { type: 'button', class: 'play-btn', title: label, 'aria-label': label, onclick: () => (media.paused ? media.play().catch(() => {}) : media.pause()) }, face, video ? null : media);
  const playing = (on) => {
    btn.classList.toggle('playing', on);
    setChildren(face, on ? '❚❚' : video ? icon('video') : '▶');
  };
  playing(false);
  media.addEventListener('play', () => playing(true));
  media.addEventListener('pause', () => playing(false));
  media.addEventListener('ended', () => playing(false));
  return btn;
}

// A question's text, with a play button once there's audio (a typed question's is read aloud in
// the background, so a pending one is watched). A spoken question's text is its transcript,
// which follows along as the recording plays. One asked on camera plays its video instead (it
// has the sound too), shown under the text while it plays.
function questionText(q) {
  if (!q.audio) {
    const body = h('p', { class: 'q-body' }, q.body);
    if (q.audioStatus === 'pending') {
      watchQuestion(q.id, body, (x) => x.audioStatus !== 'pending', (x) => {
        Object.assign(q, { audio: x.audio, audioStatus: x.audioStatus });
        body.replaceWith(questionText(q));
      });
    }
    return body;
  }
  const video = q.askerVideo ? markUpright(h('video', { class: 'q-video', src: q.askerVideo, preload: 'none', playsinline: true, hidden: true })) : null;
  const media = video ?? h('audio', { src: q.audio, preload: 'none' });
  const cues = q.audioTranscript?.cues;
  const body = cues?.length ? syncedCues(media, cues, 'q-body') : h('p', { class: 'q-body' }, q.body);
  body.append(' ', playButton(q, media));
  if (!video) return body;
  // Shown once it has a picture: on a slow connection it would be an empty black box until then.
  video.addEventListener('playing', () => (video.hidden = false));
  video.addEventListener('pause', () => (video.hidden = true));
  video.addEventListener('click', () => video.pause());
  return h('div', { class: 'q-asked' }, body, video);
}

// Published answers: each question as text, then the video answer (with subtitles once its
// transcript is ready, and its b-roll cut in). Fills `videos` (question id -> video) for the discussion.
function qaList(answers, videos) {
  return h(
    'ol',
    { class: 'qa-list' },
    answers.map((q) => {
      const video = videoPlayer(q.video, q.transcript);
      videos.set(q.id, video);
      return h(
        'li',
        { class: 'qa' },
        h('div', { class: 'qa-q' }, questionText(q), h('div', { class: 'qa-q-meta' }, questionMeta(q), h('span', { class: 'muted small' }, `▲ ${q.votes}`))),
        h('div', { class: 'qa-a' }, brollView(video, q.broll).el),
      );
    }),
  );
}

const askedBy = (q) => (q.source === 'moderator' ? 'suggested by the moderator' : q.anonymous ? 'anonymous' : q.author?.displayName);
// Who's asking, over the video while a question is played.
const askerLabel = (q) => (q.source === 'moderator' ? 'Suggested question' : q.anonymous || !q.author ? 'Someone asks' : `${q.author.displayName} asks`);

// The Q&A as text, with the discussion after it: each question, the transcript of its answer, then
// people's replies to the answer. `onChange(q)` hears when an answer's transcript becomes ready or
// is corrected.
function discussion(oh, answers, onChange) {
  const items = answers.map((q) =>
    h(
      'div',
      { class: 'ft-item' },
      h('p', { class: 'ft-q' }, q.body, askedBy(q) ? h('span', { class: 'muted small' }, ` — ${askedBy(q)}`) : null),
      answerBlock(oh, q, onChange),
      replyThread(oh, q),
    ),
  );
  return h('section', { class: 'full-transcript' }, h('h2', {}, 'Discussion'), items);
}

// The replies to one answer. Anyone can reply to the answer; only the expert can respond to a reply,
// and that's as deep as it goes. What the expert writes is marked as theirs. The expert's own
// replies to the answer add to it, so they go right under it, before everyone else's, with the box
// to write them.
function replyThread(oh, q) {
  const all = q.discussion ?? [];
  const additions = all.filter((r) => r.byExpert);
  const replies = all.filter((r) => !r.byExpert);
  const additionList = h('div', { class: 'replies answer-additions' });
  const list = h('div', { class: 'replies' });
  const count = h('p', { class: 'replies-count muted small' });
  const draw = () => {
    setChildren(additionList, additions.map((r) => replyItem(oh, q, r)));
    setChildren(list, replies.map((r) => replyItem(oh, q, r)));
    count.textContent = replies.length ? `${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}` : '';
  };
  draw();
  const post = (to) => async (body) => {
    const { reply } = await api('POST', `/api/questions/${q.id}/replies`, { body });
    to.push({ ...reply, responses: [] });
    draw();
  };
  if (oh.isExpert) return h('div', { class: 'thread' }, additionList, h('div', { class: 'answer-additions' }, replyOpener('Add to your answer', 'Add to your answer…', 'Add', post(additions))), count, list);
  // Everyone else replies from beside the count; the box opens under it, above the replies.
  const composer = h('div', { class: 'reply-composer' });
  const closeComposer = () => setChildren(composer);
  const addReply = h('button', {
    type: 'button',
    class: 'btn btn-outline btn-small',
    onclick: () => {
      if (!me) return requireLogin();
      if (!composer.firstChild) setChildren(composer, replyForm(`Reply to ${oh.expert.displayName}’s answer…`, 'Reply', async (body) => (await post(replies)(body), closeComposer()), { cancel: closeComposer }));
      composer.querySelector('textarea').focus();
    },
  }, 'Add Reply');
  return h('div', { class: 'thread' }, additionList, h('div', { class: 'replies-head' }, count, addReply), composer, list);
}

// A button that opens a reply box; it closes again once the reply is sent, or on Cancel.
function replyOpener(label, placeholder, submitLabel, send) {
  const box = h('div', { class: 'reply-opener' });
  const closed = () =>
    setChildren(box, h('button', {
      type: 'button',
      class: 'btn btn-outline btn-small',
      onclick: () => {
        if (!me) return requireLogin();
        setChildren(box, replyForm(placeholder, submitLabel, async (body) => (await send(body), closed()), { cancel: closed }));
        box.querySelector('textarea').focus();
      },
    }, label));
  closed();
  return box;
}

function replyItem(oh, q, r) {
  const responses = h('div', { class: 'responses' });
  const drawResponses = () => setChildren(responses, r.responses.map((x) => h('div', { class: 'reply reply-response' }, replyHead(x), replyBody(x))));
  drawResponses();
  const respondBox = h('div', { hidden: true });
  const respond = oh.isExpert && !r.byExpert
    ? h('button', {
        type: 'button',
        class: 'link-btn small',
        onclick: () => {
          if (!respondBox.hidden) return respondBox.querySelector('textarea').focus();
          setChildren(respondBox, replyForm(`Respond to ${r.author.displayName}…`, 'Respond', async (body) => {
            const { reply } = await api('POST', `/api/questions/${q.id}/replies`, { body, parentId: r.id });
            r.responses.push(reply);
            drawResponses();
            respondBox.hidden = true;
          }, { cancel: () => (respondBox.hidden = true) }));
          respondBox.hidden = false;
          respondBox.querySelector('textarea').focus();
        },
      }, 'Respond')
    : null;
  return h('div', { class: r.byExpert ? 'reply reply-addition' : 'reply' }, replyHead(r), replyBody(r, respond), responses, respondBox);
}

function replyHead(r) {
  return h(
    'div',
    { class: 'reply-head' },
    likeButton(r),
    userLink(r.author),
    r.byExpert ? h('span', { class: 'tag tag-expert' }, 'Expert') : null,
    r.mine ? h('span', { class: 'tag tag-you' }, 'you') : null,
    h('span', { class: 'muted small', title: fmtDate(r.createdAt) }, relative(r.createdAt)),
  );
}

function replyBody(r, ...extra) {
  return [h('p', { class: 'reply-body' }, r.body), extra.some(Boolean) ? h('div', { class: 'reply-actions' }, extra) : null];
}

function likeButton(r) {
  const label = () => (r.mine ? 'Your reply' : r.liked ? 'Unlike' : 'Like');
  const btn = h('button', { type: 'button', class: `like${r.liked ? ' liked' : ''}`, title: label(), 'aria-pressed': String(r.liked), disabled: r.mine }, h('span', { class: 'like-heart' }, '♥'), h('span', { class: 'like-count' }, r.likes || ''));
  btn.addEventListener(
    'click',
    action(async () => {
      if (!me) return requireLogin();
      Object.assign(r, await api(r.liked ? 'DELETE' : 'POST', `/api/replies/${r.id}/like`));
      btn.classList.toggle('liked', r.liked);
      btn.setAttribute('aria-pressed', String(r.liked));
      btn.title = label();
      btn.querySelector('.like-count').textContent = r.likes || '';
    }),
  );
  return btn;
}

// A text box for a reply. `send(body)` posts it; the box clears once it's sent.
function replyForm(placeholder, label, send, { cancel = null } = {}) {
  const textarea = h('textarea', { rows: 2, maxlength: 2000, placeholder, required: true });
  const submit = h('button', { class: 'btn btn-primary btn-small', type: 'submit' }, label);
  const form = h(
    'form',
    { class: 'reply-form' },
    textarea,
    h('div', { class: 'row gap-sm' }, submit, cancel ? h('button', { type: 'button', class: 'link-btn small', onclick: cancel }, 'Cancel') : null),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    action(async () => {
      await send(textarea.value);
      textarea.value = '';
    })({ currentTarget: submit });
  });
  return form;
}

// One answer in the discussion, as its transcript. The expert can correct it here too.
function answerBlock(oh, q, onChange) {
  const box = h('div', { class: 'ft-a' });
  const speaker = h('span', { class: 'ft-speaker' }, oh.expert.displayName);
  const changed = (next) => {
    q.transcript = next;
    onChange(q);
    draw();
  };
  const draw = () => {
    const t = q.transcript;
    const edit = oh.isExpert && t?.status === 'ready' && t.cues.length
      ? editButton(() => setChildren(box, speaker, transcriptEditor(t.cues, {
          save: async (lines) => (await api('PUT', `/api/questions/${q.id}/answer-transcript`, { cues: lines })).transcript,
          done: (next) => (next ? changed(next) : draw()),
        })))
      : null;
    setChildren(box, h('div', { class: 'row gap-sm' }, speaker, edit), answerText(q, t, box, changed));
  };
  draw();
  return box;
}

// An answer's transcript as paragraphs. A pending one is watched (while `container` is on the
// page) until it's ready, then handed to `onReady`. A video recorded in a session starts with the
// question being played; that part is left out, since the question is already written above it.
function answerText(question, transcript, container, onReady) {
  if (transcript?.status === 'pending') {
    watchQuestion(question.id, container, (q) => q.transcript?.status !== 'pending', (q) => onReady(q.transcript));
    return [h('p', { class: 'muted' }, 'Transcribing this answer…')];
  }
  if (!transcript || transcript.status === 'failed') return [h('p', { class: 'muted' }, "This answer couldn't be transcribed.")];
  const cues = transcript.cues.filter(([start, end]) => (start + end) / 2 >= (question.answerStart ?? 0));
  if (!cues.length) return [h('p', { class: 'muted' }, 'No speech was detected in this answer.')];
  // A pause of a second or more starts a new paragraph.
  const paragraphs = [[]];
  cues.forEach(([start, , text], i) => {
    if (i && start - cues[i - 1][1] >= 1) paragraphs.push([]);
    paragraphs.at(-1).push(text);
  });
  return folded(paragraphs.map((p) => p.join(' ')));
}

// Paragraphs of text, at most FOLD lines of them until "Show more" shows the rest, which "Show less"
// folds again. Folded, the paragraph those lines end in is cut short with an ellipsis and the ones
// after it are left out. The button only shows when there's more. The lines are counted with the
// paragraphs laid out in full, again whenever the size changes.
const FOLD = 4;
function folded(texts) {
  const ps = texts.map((text) => h('p', {}, text));
  const box = h('div', { class: 'folded' }, ps);
  let open = false;
  const button = h('button', { type: 'button', class: 'link-btn small fold-btn', hidden: true, onclick: () => ((open = !open), fold()) });
  function fold() {
    ps.forEach((p) => ((p.hidden = false), p.classList.remove('cut')));
    let left = FOLD;
    let last = -1; // the last paragraph shown while it's folded, if there's more
    let cut = false; // whether that one is cut short
    for (const [i, p] of ps.entries()) {
      const lines = Math.round(p.offsetHeight / parseFloat(getComputedStyle(p).lineHeight));
      if (lines > left || (lines === left && i < ps.length - 1)) {
        [last, cut] = [i, lines > left];
        break;
      }
      left -= lines;
    }
    button.hidden = last < 0;
    button.textContent = open ? 'Show less' : 'Show more';
    if (open || last < 0) return;
    if (cut) {
      ps[last].classList.add('cut');
      ps[last].style.setProperty('--lines', left);
    }
    ps.slice(last + 1).forEach((p) => (p.hidden = true));
  }
  new ResizeObserver(fold).observe(box);
  return [box, button];
}

// Player control icons. Inline SVG, since symbols like ⛶ are missing from many fonts.
const ICONS = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  sound: '<path d="M4 9v6h4l5 4V5L8 9zM16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill-rule="evenodd" stroke-linecap="round"/>',
  muted: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  exitFullscreen: '<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  video: '<path d="M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM17 10l5-3v10l-5-3z"/>',
};
function icon(name) {
  const el = h('span', { class: 'icon' });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">${ICONS[name]}</svg>`;
  return el;
}

// The published answers as one video: the takes joined end to end on the server (src/video.js).
// It has its own controls, so captions and the asker stay on it in fullscreen. Captions are drawn
// at the bottom, except for answers whose captions are burned into the video (`captions` on their
// chapter, when the server finished it). While a question is being played, a picture at the top
// left shows who asked: the asker's video for a question asked on camera, from the moment it starts
// and kept in step with the question, and otherwise the fox saying it. `chapters` place each answer in the video, and where
// its question's sound starts in it (`questionStart`), which the fox and the asker's video follow;
// its question's cues and its transcript's are timed from the start of its take. `update(q)` picks
// up a transcript that's ready or corrected.
function jointPlayer(answers, { src, chapters }) {
  const byId = new Map(answers.map((q) => [q.id, q]));
  const parts = chapters.filter((c) => byId.has(c.questionId)).map((c) => ({ ...c, q: byId.get(c.questionId) }));
  const total = parts.at(-1)?.end ?? 0;
  const partAt = (t) => parts.find((p) => t < p.end) ?? parts.at(-1);
  let cues = []; // [start, end, text] over the whole video
  const recue = () => {
    cues = parts.flatMap(({ start, end, q, captions }) =>
      captions
        ? []
        : [...(q.questionCues ?? []), ...(q.transcript?.status === 'ready' ? q.transcript.cues : [])].map(([s, e, text]) => [start + s, Math.min(start + e, end), text]),
    );
  };
  recue();

  const video = fixDuration(h('video', { class: 'jp-video', src, preload: 'metadata', playsinline: true }), { firstFrame: true });
  const caption = h('span', { class: 'jp-caption', hidden: true });
  const stand = fox(h('canvas', { class: 'jp-fox' })); // stands in for an asker who wasn't on camera
  const faceSlot = h('span', { class: 'jp-face-slot' });
  const pip = h('span', { class: 'jp-pip' }, stand.el, faceSlot);
  const asker = h('span', { class: 'jp-asker' });
  const asking = h('div', { class: 'jp-asking', 'aria-hidden': 'true' }, pip, asker);
  const btn = (label, text, onclick) => h('button', { type: 'button', class: 'jp-btn', title: label, 'aria-label': label, onclick }, text);
  const playBtn = btn('Play (k)', icon('play'), () => toggle());
  const ccBtn = btn('Captions (c)', 'CC', () => setCaptions(!captionsOn));
  ccBtn.hidden = parts.length > 0 && parts.every((p) => p.captions); // they're all in the picture
  const muteBtn = btn('Mute (m)', icon('sound'), () => (video.muted = !video.muted));
  const fullscreenBtn = btn('Fullscreen (f)', icon('fullscreen'), () => toggleFullscreen());
  const time = h('span', { class: 'jp-time' });
  const fill = h('span', { class: 'jp-fill' });
  const tip = h('span', { class: 'jp-tip', hidden: true });
  const pct = (t) => (total ? (100 * t) / total : 0);
  const bar = h(
    'div',
    { class: 'jp-bar', role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': String(Math.round(total)) },
    fill,
    parts.slice(1).map((p) => h('span', { class: 'jp-tick', style: `left: ${pct(p.start)}%` })), // where each answer starts
    tip,
  );
  const controls = h('div', { class: 'jp-controls' }, playBtn, time, bar, ccBtn, muteBtn, fullscreenBtn);
  const el = h(
    'div',
    { class: 'joint-player', tabindex: '-1' },
    video,
    h('div', { class: 'jp-captions', 'aria-hidden': 'true' }, caption), // the transcript is on the page as text
    asking,
    // It hides once clicked, so keyboard shortcuts move over to the player.
    h('button', { type: 'button', class: 'jp-big-play', 'aria-label': 'Play', onclick: () => (el.focus({ preventScroll: true }), play()) }, icon('play')),
    controls,
  );

  let started = false; // captions and the asker wait until it's played, or the viewer moves through it
  let captionsOn = true;
  const begin = () => {
    started = true;
    el.classList.add('started');
  };
  const seek = (t) => {
    begin();
    video.currentTime = Math.max(0, Math.min(t, total));
  };
  const play = (t) => {
    if (t != null) seek(t);
    listen();
    video.play().catch(() => {});
  };

  // Until a question's lip sync has loaded, or if it has none, the fox's mouth follows how loud
  // the question is. That means routing the video's sound through Web Audio, which browsers only
  // allow starting from a click or key press, as play() always is. If it can't be set up, the
  // mouth stays shut.
  let analyser = null; // false once it's been tried and failed
  let samples = null;
  let level = 0; // 0-1, smoothed
  function listen() {
    if (analyser != null || typeof AudioContext === 'undefined') return;
    analyser = false;
    try {
      const ctx = new AudioContext();
      const node = ctx.createAnalyser();
      node.fftSize = 1024;
      ctx.createMediaElementSource(video).connect(node);
      node.connect(ctx.destination);
      ctx.resume().catch(() => {});
      samples = new Uint8Array(node.fftSize);
      analyser = node;
    } catch {
      // the video plays as it is
    }
  }
  function loudness() {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / samples.length) * 5); // speech is around 0.05-0.2 RMS
  }
  const toggle = () => (video.paused || video.ended ? play() : video.pause());
  function setCaptions(on) {
    captionsOn = on;
    ccBtn.setAttribute('aria-pressed', String(on));
    tick();
  }
  function toggleFullscreen() {
    if (document.fullscreenElement ?? document.webkitFullscreenElement) (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else video.webkitEnterFullscreen?.(); // iPhone: only a video itself can go fullscreen, without the overlays
  }
  const onFullscreen = () => {
    const on = (document.fullscreenElement ?? document.webkitFullscreenElement) === el;
    el.classList.toggle('is-fullscreen', on);
    setChildren(fullscreenBtn, icon(on ? 'exitFullscreen' : 'fullscreen'));
    fullscreenBtn.setAttribute('aria-label', on ? 'Exit fullscreen (f)' : 'Fullscreen (f)');
    tick(); // the fox is redrawn at its new size
  };
  el.addEventListener('fullscreenchange', onFullscreen);
  el.addEventListener('webkitfullscreenchange', onFullscreen);

  // The askers' videos, for questions asked on camera, muted: their sound is in the joined video.
  // Each loads while the answer before it plays, showing its first frame once it has, so it's ready
  // when its question comes up.
  const faces = new Map(); // question id -> <video>
  function face(q) {
    if (!faces.has(q.id)) {
      const f = markUpright(fixDuration(h('video', { class: 'jp-face', src: q.askerVideo, preload: 'metadata', playsinline: true }), { firstFrame: true }));
      f.muted = true;
      faces.set(q.id, f);
    }
    return faces.get(q.id);
  }
  let shownFace = null;
  function showFace(f, at) {
    if (f !== shownFace) {
      shownFace?.pause();
      setChildren(faceSlot, f);
      shownFace = f;
    }
    if (f) {
      // Seek only once the browser knows how long it is (see fixDuration), and when it has drifted.
      if (Number.isFinite(f.duration) && Math.abs(f.currentTime - at) > 0.3) f.currentTime = Math.min(at, f.duration);
      if (!advancing(video)) f.pause();
      else if (f.paused && !f.ended) f.play().catch(() => {}); // it may end a moment before the question does
    }
    asking.classList.toggle('has-face', Boolean(f));
  }

  // The questions' lip sync, for the fox. Each loads while the answer before it plays.
  const lipSyncs = new Map(); // question id -> {fps, frames}; null while it loads, or if it couldn't
  function lipSync(q) {
    if (q.lipSync && !lipSyncs.has(q.id)) {
      lipSyncs.set(q.id, null);
      api('GET', q.lipSync).then((res) => lipSyncs.set(q.id, res.lipSync), () => {});
    }
    return lipSyncs.get(q.id) ?? null;
  }

  let askingFor = null;
  function tick() {
    const t = video.currentTime;
    const cue = started && captionsOn ? cues.find(([start, end]) => t >= start && t < end) : null;
    caption.hidden = !cue;
    if (cue && caption.textContent !== cue[2]) caption.textContent = cue[2];
    // The take starts with the question being played, up to where the answer starts.
    const part = partAt(t);
    const q = started && part?.q.answerStart != null && t >= part.start && t < part.start + part.q.answerStart ? part.q : null;
    caption.classList.toggle('is-question', Boolean(q));
    if (q && q !== askingFor) {
      askingFor = q;
      asker.textContent = askerLabel(q);
    }
    asking.classList.toggle('show', Boolean(q));
    const i = parts.indexOf(part);
    for (const p of [parts[i], parts[i + 1]]) {
      if (!started || !p) continue;
      if (p.q.askerVideo) face(p.q).preload = 'auto';
      lipSync(p.q);
    }
    // How far into the question's sound, which starts a little after its take does.
    const at = q ? t - part.start - (part.questionStart ?? 0) : 0;
    showFace(q?.askerVideo ? face(q) : null, at);
    level = q && analyser && !video.paused ? 0.6 * level + 0.4 * loudness() : 0.85 * level;
    if (q && !q.askerVideo) {
      const sync = lipSync(q);
      stand.draw(sync ? (sync.frames[Math.floor(at * sync.fps)] ?? [0, 1, 0]) : [level, 1, level], blinkAt(q.id, at), at);
    }
    fill.style.width = `${pct(t)}%`;
    time.textContent = `${fmtDuration(t)} / ${fmtDuration(total)}`;
    bar.setAttribute('aria-valuenow', String(Math.round(t)));
    bar.setAttribute('aria-valuetext', `${fmtDuration(t)} of ${fmtDuration(total)}`);
  }
  // Captions follow every frame while it plays; timeupdate alone is only a few times a second.
  let frame = 0;
  const loop = () => {
    tick();
    frame = video.paused ? 0 : requestAnimationFrame(loop);
  };
  video.addEventListener('play', () => {
    begin();
    el.classList.add('playing');
    setChildren(playBtn, icon('pause'));
    playBtn.setAttribute('aria-label', 'Pause (k)');
    cancelAnimationFrame(frame);
    loop();
  });
  video.addEventListener('pause', () => {
    el.classList.remove('playing');
    setChildren(playBtn, icon('play'));
    playBtn.setAttribute('aria-label', 'Play (k)');
    tick();
  });
  video.addEventListener('volumechange', () => setChildren(muteBtn, icon(video.muted ? 'muted' : 'sound')));
  ['timeupdate', 'seeked', 'loadedmetadata'].forEach((type) => video.addEventListener(type, tick));
  video.addEventListener('click', () => (el.focus({ preventScroll: true }), toggle()));
  video.addEventListener('dblclick', () => toggleFullscreen());

  // Scrubbing, and a tip naming the question under the pointer.
  const timeAt = (e) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total;
  };
  let scrubbing = false;
  bar.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    bar.setPointerCapture(e.pointerId);
    seek(timeAt(e));
  });
  bar.addEventListener('pointermove', (e) => {
    const t = timeAt(e);
    if (scrubbing) seek(t);
    const part = partAt(t);
    tip.textContent = `${fmtDuration(t)} · ${parts.indexOf(part) + 1}. ${part.q.summary?.question ?? part.q.body}`;
    tip.style.left = `${Math.max(15, Math.min(85, pct(t)))}%`;
    tip.hidden = false;
  });
  bar.addEventListener('pointerup', () => (scrubbing = false));
  bar.addEventListener('pointercancel', () => (scrubbing = false));
  bar.addEventListener('pointerleave', () => (tip.hidden = true));

  el.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter'))) return;
    const keys = {
      ' ': toggle,
      k: toggle,
      f: toggleFullscreen,
      c: () => setCaptions(!captionsOn),
      m: () => (video.muted = !video.muted),
      ArrowLeft: () => seek(video.currentTime - 5),
      ArrowRight: () => seek(video.currentTime + 5),
      Home: () => seek(0),
      End: () => seek(total),
    };
    if (!keys[e.key]) return;
    e.preventDefault();
    keys[e.key]();
  });

  // The controls get out of the way while it plays, until the pointer moves.
  let idle = 0;
  const wake = () => {
    el.classList.remove('idle');
    clearTimeout(idle);
    idle = setTimeout(() => el.classList.add('idle'), 2500);
  };
  ['pointermove', 'pointerdown', 'keydown'].forEach((type) => el.addEventListener(type, wake));

  setCaptions(true);
  return {
    el,
    video,
    parts,
    partAt,
    play,
    update() {
      recue();
      tick();
    },
  };
}

// The questions under the video, to skip to: each where it starts, its number, and the moderator's
// few words for it, or the question cut short, in two lines at most. Each is one thing to click,
// which plays it from the question; the one being played is highlighted. Summaries are written once
// an answer is transcribed (and again when it's corrected), so answers still waiting for one are
// watched. `refresh(q)` fetches a new one after a correction.
function skipTo(player) {
  const items = new Map(); // question id -> its button
  const watching = new Set();
  const list = h('ol', { class: 'st-list' });
  for (const part of player.parts) {
    const item = h('button', { type: 'button', class: 'st-item', title: `Play from ${fmtDuration(part.start)}`, onclick: () => player.play(part.start) });
    items.set(part.q.id, item);
    list.append(h('li', {}, item));
    draw(part);
  }

  // Spans: a button may only hold inline content.
  function draw(part) {
    const { q, start } = part;
    setChildren(items.get(q.id), h('span', { class: 'st-time' }, fmtDuration(start)), h('span', { class: 'st-q' }, q.summary?.question ?? q.body));
    if (q.transcript?.status === 'pending' || q.summary?.pending) watch(part);
  }

  const update = (part, question) => {
    Object.assign(part.q, { transcript: question.transcript, summary: question.summary });
    player.update(part.q);
    draw(part);
  };

  function watch(part) {
    if (watching.has(part.q.id)) return;
    watching.add(part.q.id);
    watchQuestion(part.q.id, list, (x) => x.transcript?.status !== 'pending' && !x.summary?.pending, (x) => {
      watching.delete(part.q.id);
      update(part, x);
    });
  }

  function highlight() {
    const { video } = player;
    const t = video.currentTime;
    const part = video.paused && t < 0.05 ? null : player.partAt(t); // nothing before it's played
    items.forEach((item, id) => item.classList.toggle('is-current', part?.q.id === id));
  }
  ['timeupdate', 'seeked'].forEach((type) => player.video.addEventListener(type, highlight));

  return {
    el: h('section', { class: 'skip-to' }, h('h2', {}, 'Skip to'), list),
    refresh(q) {
      const part = player.parts.find((p) => p.q === q);
      api('GET', `/api/questions/${q.id}`).then(({ question }) => update(part, question), (err) => toast(err.message, 'error'));
    },
  };
}

// For the expert while their answers are being joined into one video, which takes a few minutes.
// The page shows the video as soon as it's ready.
function processingNote(oh) {
  const el = h('p', { class: 'notice' }, 'Your answers are published, and the video is being processed. It usually takes a few minutes; this page shows it as soon as it’s ready. Until then, everyone else sees this off hour as closed.');
  const tick = async () => {
    if (!el.isConnected) return;
    try {
      const { video } = await api('GET', `/api/office-hours/${oh.id}/video`, null, { timeout: 10_000 });
      if (video?.status !== 'pending') return render();
    } catch {
      // failed or hung: try again on the next tick
    }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 5000);
  return el;
}

function ohCard(oh) {
  return h(
    'a',
    { class: 'card card-link oh-card', href: `#/oh/${oh.id}` },
    h('div', { class: 'row gap-sm wrap' }, topicChip(oh), statusBadge(oh)),
    h('h3', {}, oh.title),
    h('p', { class: 'muted small' }, `with ${oh.expert.displayName} · ${oh.questionCount} question${oh.questionCount === 1 ? '' : 's'}`),
  );
}

function empty(message, ...extra) {
  return h('div', { class: 'empty' }, h('p', {}, message), extra);
}

// ---------- pages ----------

async function feedPage() {
  const { items } = await api('GET', '/api/feed');
  return h(
    'div',
    {},
    h('div', { class: 'page-head' }, h('h1', {}, 'Your feed'), h('a', { class: 'btn btn-primary', href: '#/oh/new' }, '+ Host off hours')),
    items.length === 0
      ? empty('Nothing here yet. Subscribe to experts or off hours and they\'ll show up here.', h('a', { class: 'btn btn-outline', href: '#/explore' }, 'Explore off hours'))
      : h('div', { class: 'stack' }, items.map(feedItem)),
  );
}

// Feed cards are teasers: no asking or reading answers here, just enough to click through.
function feedItem(item) {
  const oh = item.officeHour;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const head = h(
    'div',
    { class: 'feed-head' },
    h('span', { class: 'avatar' }, oh.expert.displayName.charAt(0).toUpperCase()),
    h(
      'div',
      {},
      h('div', {}, userLink(oh.expert), item.type === 'announced' ? ' announced off hours' : ` answered ${plural(item.answerCount, 'question')}`),
      h('div', { class: 'muted small' }, relative(item.at)),
    ),
  );
  const title = h('div', { class: 'feed-title' }, h('a', { href: `#/oh/${oh.id}` }, h('h2', {}, oh.title)), h('div', { class: 'row gap-sm wrap' }, topicChip(oh), item.type === 'announced' ? statusBadge(oh) : null));
  const cta = (label, primary = true) => h('div', { class: 'feed-foot' }, h('a', { class: `btn ${primary ? 'btn-primary' : 'btn-outline'}`, href: `#/oh/${oh.id}` }, label));

  if (item.type === 'announced') {
    let action;
    if (oh.status === 'published') action = cta('Read the answers →');
    else if (oh.isExpert) action = cta('View off hour →', false);
    else if (oh.status === 'open') action = cta('Ask a question →');
    else action = cta('View questions →', false);
    return h('article', { class: 'card feed-item' }, head, title, oh.description ? h('p', { class: 'desc clamp' }, oh.description) : null, action);
  }

  const more = item.answerCount - item.preview.length;
  return h(
    'article',
    { class: 'card feed-item feed-published' },
    head,
    title,
    h('ul', { class: 'feed-preview' }, item.preview.map((q) => h('li', {}, q.body)), more > 0 ? h('li', { class: 'muted' }, `+ ${plural(more, 'more question')}`) : null),
    cta('Read the answers →'),
  );
}

async function explorePage() {
  const { open, published, people } = await api('GET', '/api/explore');
  return h(
    'div',
    {},
    h('div', { class: 'page-head' }, h('h1', {}, 'Explore'), me ? h('a', { class: 'btn btn-primary', href: '#/oh/new' }, '+ Host off hours') : null),
    h('section', {}, h('h2', { class: 'section-title' }, 'Taking questions now'), open.length ? h('div', { class: 'grid' }, open.map(ohCard)) : empty('No off hours are open right now.')),
    h('section', {}, h('h2', { class: 'section-title' }, 'Recently answered'), published.length ? h('div', { class: 'grid' }, published.map(ohCard)) : empty('Nothing answered yet.')),
    h(
      'section',
      {},
      h('h2', { class: 'section-title' }, 'People'),
      h(
        'div',
        { class: 'grid' },
        people.map((p) =>
          h(
            'div',
            { class: 'card person' },
            h('a', { href: `#/u/${p.username}` }, h('h3', {}, p.displayName)),
            h('p', { class: 'muted small' }, `@${p.username} · ${p.subscribers} subscriber${p.subscribers === 1 ? '' : 's'} · ${p.hosted} off hour${p.hosted === 1 ? '' : 's'}`),
            h('div', { class: 'row gap-sm wrap' }, p.expertise.map((t) => h('span', { class: 'chip' }, t))),
            me && me.id !== p.id ? subscribeButton({ type: 'expert', id: p.id, subscribed: p.subscribed }) : null,
          ),
        ),
      ),
    ),
  );
}

async function officeHourPage({ id }) {
  const data = await api('GET', `/api/office-hours/${id}`);
  const oh = data.officeHour;
  const canVote = oh.status === 'open';

  const header = h(
    'div',
    { class: 'card oh-header' },
    h('div', { class: 'row gap-sm wrap' }, topicChip(oh), statusBadge(oh), oh.allowAnonymous ? h('span', { class: 'chip chip-muted' }, 'Anonymous OK') : null),
    h('h1', {}, oh.title),
    h('p', { class: 'byline' }, 'with ', oh.isExpert ? userLink(oh.expert) : expertCard(oh)),
    oh.followUpOf ? h('p', { class: 'muted small' }, 'Follows up on ', h('a', { href: `#/oh/${oh.followUpOf.id}` }, oh.followUpOf.title)) : null,
    oh.description ? h('p', { class: 'desc' }, oh.description) : null,
    data.followUps.length ? h('p', { class: 'muted small' }, 'Followed up in ', data.followUps.map((f, i) => [i ? ', ' : null, h('a', { href: `#/oh/${f.id}` }, f.title)])) : null,
    h(
      'dl',
      { class: 'facts' },
      questionsFact(oh),
      h('div', {}, h('dt', {}, 'Answers expected'), h('dd', {}, fmtDate(oh.answersExpectedAt))),
      h('div', {}, h('dt', {}, 'Questions'), h('dd', {}, oh.questionCount)),
    ),
    h(
      'div',
      { class: 'row gap-sm wrap' },
      oh.isExpert && oh.status !== 'published' ? h('a', { class: 'btn btn-primary', href: `#/oh/${oh.id}/manage` }, 'Plan & answer') : null,
      oh.isExpert && oh.status === 'published' && !oh.processing ? h('a', { class: 'btn btn-outline', href: `#/oh/new?followUp=${oh.id}` }, 'Create follow-up Q&A') : null,
      !oh.isExpert ? subscribeButton({ type: 'office_hour', id: oh.id, subscribed: oh.subscribed, label: 'this off hour' }) : null,
    ),
  );

  // While the answers are being joined into one video, the page stays as it was when questions
  // closed (readers see it as closed); the expert gets a note, and the page updates once it's ready.
  if (oh.status === 'published' && !oh.processing) {
    const answeredIds = new Set(data.answers.map((q) => q.id));
    const rest = data.groups.flatMap((g) => g.questions).filter((q) => !answeredIds.has(q.id));
    const title = h('h2', { class: 'section-title' }, `${data.answers.length} answered question${data.answers.length === 1 ? '' : 's'}`);
    // Questions that weren't answered are the expert's alone; readers aren't sent them.
    const unanswered = oh.isExpert && rest.length
      ? h('details', { class: 'card' }, h('summary', {}, `${rest.length} question${rest.length === 1 ? ' was' : 's were'} not answered`, h('span', { class: 'muted small' }, ' · only you see these')), h('ul', { class: 'q-list' }, rest.map((q) => questionRow(q, { canVote: false }))))
      : null;
    if (data.video?.status === 'ready') {
      // One video, with its questions under it to skip to, and the player docked under the top bar
      // while they're scrolled. The full transcript is folded away.
      const player = jointPlayer(data.answers, data.video);
      const skip = skipTo(player);
      const onChange = (q) => (player.update(q), skip.refresh(q));
      return h('div', { class: 'stack' }, header, h('section', {}, title, h('div', { class: 'jp-dock' }, player.el), skip.el), discussion(oh, data.answers, onChange), unanswered);
    }
    // Without ffmpeg, or if joining failed, each answer has its own video.
    const videos = new Map();
    return h(
      'div',
      { class: 'stack' },
      header,
      h('section', {}, title, qaList(data.answers, videos)),
      discussion(oh, data.answers, (q) => addCaptions(videos.get(q.id), q.transcript)),
      unanswered,
    );
  }

  const groups = data.groups.length
    ? data.groups.map((g) => h('section', { class: 'group' }, h('div', { class: 'group-head' }, h('h3', {}, g.label), h('span', { class: 'muted small' }, `${g.questions.length} question${g.questions.length === 1 ? '' : 's'}`)), h('ul', { class: 'q-list' }, g.questions.map((q) => questionRow(q, { canVote })))))
    : [empty(oh.status === 'open' ? 'No questions yet — be the first to ask.' : 'No questions were asked.')];

  return h(
    'div',
    { class: 'stack' },
    header,
    oh.processing ? processingNote(oh) : null,
    oh.status === 'open' && !oh.isExpert ? h('div', { class: 'card ask-card' }, askForm(oh, () => render())) : null,
    h(
      'section',
      { class: 'questions' },
      h('div', { class: 'row space-between section-head' }, h('h2', { class: 'section-title' }, 'Questions'), h('span', { class: 'muted small', title: 'Similar questions are grouped by the moderator' }, '✦ grouped by the moderator')),
      groups,
    ),
  );
}

async function managePage({ id }) {
  const data = await api('GET', `/api/office-hours/${id}`);
  const oh = data.officeHour;
  // Published answers are final, so there's nothing left to plan.
  if (!oh.isExpert || oh.status === 'published') {
    go(`#/oh/${id}`);
    return h('div');
  }

  const questions = new Map(data.groups.flatMap((g) => g.questions).map((q) => [q.id, q]));
  let queue = [...data.plan.queue];
  const videos = new Map([...questions.values()].map((q) => [q.id, q.answerVideo])); // draft answer URL per question
  const transcripts = new Map([...questions.values()].map((q) => [q.id, q.answerTranscript])); // and its transcript
  const brolls = new Map([...questions.values()].map((q) => [q.id, q.broll])); // and its b-roll
  // The answer order saves itself whenever it changes, so leaving or refreshing never loses it.
  let edits = 0; // changes made to the answer order
  let savedEdits = 0; // how many of them the server has
  let saving = Promise.resolve(); // saves run one at a time
  let saveFailed = false;
  let savedAt = null;

  const saveState = h('span', { class: 'muted small' });
  const publishBtn = h('button', { class: 'btn btn-primary' }, 'Publish answers');

  function updateBar() {
    if (saveFailed) saveState.textContent = "Couldn't save your answer order";
    else if (savedEdits < edits) saveState.textContent = 'Saving…';
    else saveState.textContent = savedAt ? `Draft saved ${savedAt}` : '';
  }
  const markDirty = () => {
    edits += 1;
    updateBar();
    save().catch((err) => {
      if (err.status === 401) return requireLogin();
      toast(`Couldn't save your answer order: ${err.message}`, 'error');
    });
  };
  window.onbeforeunload = () => (savedEdits < edits || session || finishing || uploads.size || brollUploads.size ? true : undefined);
  pageCleanup = () => {
    session?.close();
    local.forEach((url) => URL.revokeObjectURL(url));
  };

  // Saves the answer order as it is now, after any save already under way.
  function save() {
    const run = saving.catch(() => {}).then(async () => {
      const upTo = edits;
      try {
        await api('PUT', `/api/office-hours/${oh.id}/plan`, { items: queue.map((qid) => ({ questionId: qid })) });
      } catch (err) {
        saveFailed = true;
        updateBar();
        throw err;
      }
      saveFailed = false;
      savedEdits = Math.max(savedEdits, upTo);
      savedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      updateBar();
    });
    saving = run;
    return run;
  }

  publishBtn.addEventListener(
    'click',
    action(async () => {
      if (finishing || uploads.size) throw new Error('Wait for your answers to finish saving (or discard any that failed) before publishing.');
      if (brollUploads.size) throw new Error('Wait for your b-roll to finish uploading before publishing.');
      const making = queue.find((qid) => videos.get(qid) && brolls.get(qid)?.status === 'pending');
      if (making) throw new Error(`The b-roll for question ${queue.indexOf(making) + 1} is still being made. Wait for it, or remove it, before publishing.`);
      const answered = queue.filter((qid) => videos.get(qid)).length;
      const unanswered = queue.length - answered;
      const note = unanswered ? `\n\n${unanswered} queued question(s) have no recorded answer and will be left out.` : '';
      if (!confirm(`Publish ${answered} answer(s)? Subscribers will see them in their feed.${note}\n\nThis is final: you won't be able to re-record, remove or reorder answers afterwards.`)) return;
      await save();
      await api('POST', `/api/office-hours/${oh.id}/publish`);
      window.onbeforeunload = null;
      toast('Published!', 'success');
      go(`#/oh/${oh.id}`);
    }),
  );
  updateBar();

  // ----- recording answers -----
  // Answers are recorded in sessions: the expert starts at any queued question and answers them
  // back to back without stopping the camera. Each question is played into the recording (and
  // their headphones), then they answer; Next keeps that take as the question's answer and plays
  // the next question. Each take is its own recording, so it uploads while they carry on.
  const uploads = new Map(); // question id -> { blob, url, answerStart, failed } for a take that's saving or failed to save
  let uploading = Promise.resolve(); // takes upload one at a time, in the order they were recorded
  let finishing = 0; // takes kept but still being finalized by the browser, about to start saving
  let session = null; // the recording session, while it's open

  // Takes recorded on this page keep playing from the browser's copy once saved, rather than
  // switching to the server's and downloading the video again.
  const local = new Map(); // question id -> object URL of its saved take

  function keepLocal(qid, url) {
    if (local.has(qid) && local.get(qid) !== url) URL.revokeObjectURL(local.get(qid));
    if (url) local.set(qid, url);
    else local.delete(qid);
  }

  // Saves a take as the question's answer, in the background.
  function upload(qid, take) {
    const previous = uploads.get(qid);
    if (previous && previous.url !== take.url) URL.revokeObjectURL(previous.url);
    uploads.set(qid, take);
    drawAnswer(qid);
    uploading = uploading.catch(() => {}).then(async () => {
      if (uploads.get(qid) !== take) return; // a newer take replaced it
      const query = take.answerStart != null ? `?answerStart=${take.answerStart.toFixed(2)}` : '';
      try {
        const res = await api('PUT', `/api/questions/${qid}/video${query}`, take.blob);
        if (uploads.get(qid) !== take) return;
        uploads.delete(qid);
        keepLocal(qid, take.url);
        videos.set(qid, res.video);
        transcripts.set(qid, res.transcript);
        brolls.set(qid, res.broll); // its b-roll moves to where it fits in the new take
      } catch (err) {
        if (uploads.get(qid) !== take) return;
        if (err.status === 401) return requireLogin();
        take.failed = true; // kept in the browser so a failed upload doesn't lose it
        toast(`Couldn't save your answer to question ${queue.indexOf(qid) + 1}: ${err.message}`, 'error');
      }
      drawAnswer(qid);
      session?.draw();
    });
  }

  function discardUpload(qid) {
    URL.revokeObjectURL(uploads.get(qid).url);
    uploads.delete(qid);
    drawAnswer(qid);
  }

  const hasAnswer = (qid) => Boolean(videos.get(qid) || uploads.has(qid));

  // Each question's answer box is cached, so re-rendering the queue (reordering, adding) doesn't
  // reload a video that's playing.
  const boxes = new Map();
  function answerBox(qid) {
    if (!boxes.has(qid)) {
      boxes.set(qid, h('div', { class: 'video-answer' }));
      drawAnswer(qid);
    }
    return boxes.get(qid);
  }

  function drawAnswer(qid) {
    const box = boxes.get(qid);
    if (!box) return;
    const buttons = (...children) => h('div', { class: 'row gap-sm wrap' }, children);
    // The video already in the box is kept if it's the same recording, so it doesn't reload.
    const current = box.querySelector('video.answer-video');
    const wasPlaying = current && !current.paused;
    const player = (src, transcript) => {
      if (current?.getAttribute('src') !== src) return videoPlayer(src, transcript);
      addCaptions(current, transcript);
      return current;
    };
    const resume = () => wasPlaying && current.isConnected && current.play().catch(() => {}); // moving it pauses it
    const take = uploads.get(qid);
    if (take) {
      setChildren(
        box,
        player(take.url),
        take.failed
          ? buttons(
              h('span', { class: 'muted small' }, "Couldn't save this answer."),
              h('button', { class: 'btn btn-primary btn-small', onclick: () => upload(qid, { ...take, failed: false }) }, 'Try again'),
              h('button', { class: 'btn btn-small', onclick: () => discardUpload(qid) }, 'Discard'),
            )
          : buttons(h('span', { class: 'muted small' }, 'Saving…')),
      );
      resume();
      return;
    }
    const url = videos.get(qid);
    const video = url ? player(local.get(qid) ?? url, transcripts.get(qid)) : null;
    const broll = brolls.get(qid);
    setChildren(
      box,
      video ? brollView(video, broll?.status === 'ready' && broll.start != null ? broll : null).el : null,
      video ? answerTranscript(video, transcripts.get(qid), { questionId: qid, pick: (q) => q.answerTranscript, onUpdate: (t) => transcripts.set(qid, t), editable: true }) : null,
      video && brollOn ? brollPanel(qid, video) : null,
      buttons(
        h('button', { class: url ? 'btn btn-small' : 'btn btn-primary btn-small', onclick: action(() => startSession(qid)) }, url ? 'Re-record from here' : '● Answer from here'),
        url ? h('button', { class: 'btn btn-small', onclick: action(() => removeAnswer(qid)) }, 'Remove') : null,
      ),
    );
    resume();
  }

  async function removeAnswer(qid) {
    if (!confirm('Delete this recorded answer?')) return;
    const res = await api('DELETE', `/api/questions/${qid}/video`);
    keepLocal(qid, null);
    videos.set(qid, null);
    transcripts.set(qid, null);
    brolls.set(qid, res.broll); // kept for the next take
    drawAnswer(qid);
  }

  // ----- b-roll -----
  // Under a recorded answer, the expert describes a shot to cut away to while they talk, or uploads
  // a video of their own, split screen or, if they tick Full screen first, full screen. The server
  // makes the shot, which takes a few minutes, or gets the video ready, and places it where it fits
  // what they're saying; the answer's video above then plays with it cut in. They can then cut in to
  // it where the answer's video is instead, and let full-screen b-roll keep playing past the end of
  // the answer. What they've typed, and ticked, is kept across redraws.
  const MAX_BROLL_UPLOAD = 500_000_000; // bytes, as the server allows
  const brollDrafts = new Map(); // question id -> description being typed
  const brollFull = new Map(); // question id -> whether a video uploaded as its b-roll is to be full screen
  const brollWatched = new Set();
  const brollUploads = new Map(); // question id -> { name, sent (0 to 1), stop, show } for a video being uploaded

  function brollPanel(qid, video) {
    const broll = brolls.get(qid);
    const box = h('div', { class: 'broll' });
    const set = (next) => {
      brolls.set(qid, next);
      drawAnswer(qid);
    };
    const remove = action(async () => set((await api('DELETE', `/api/questions/${qid}/broll`)).broll));
    // Changes how it plays; refused, the panel goes back to how it was (a box ticked, say).
    const patch = (body) =>
      action(async () => {
        try {
          set((await api('PATCH', `/api/questions/${qid}/broll`, body())).broll);
        } catch (err) {
          drawAnswer(qid);
          throw err;
        }
      });
    const form = ({ again = false } = {}) => {
      const text = h('textarea', {
        rows: 2,
        maxlength: 500,
        'aria-label': makesBroll ? 'Describe the b-roll' : 'What your video shows',
        placeholder: makesBroll
          ? 'What to cut to while you talk, e.g. "Hands sketching a wireframe on paper" or "An animated diagram of a cache going stale"'
          : 'What your video shows, e.g. "Hands sketching a wireframe on paper"',
        value: brollDrafts.get(qid) ?? (again ? broll?.prompt : ''),
        oninput: () => brollDrafts.set(qid, text.value),
      });
      const submit = makesBroll ? h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, broll ? 'Make new b-roll' : 'Make b-roll') : null;
      const full = h('input', { type: 'checkbox', checked: brollFull.get(qid) ?? (again && Boolean(broll?.full)), onchange: () => brollFull.set(qid, full.checked) });
      const file = h('input', { type: 'file', accept: 'video/*', hidden: true, onchange: () => file.files[0] && uploadBroll(qid, file.files[0], text.value, full.checked) });
      const el = h(
        'form',
        { class: 'broll-form' },
        text,
        // Before the buttons: picking a video starts uploading it.
        h('label', { class: 'check' }, full, ' Full screen'),
        h(
          'div',
          { class: 'row gap-sm wrap' },
          submit,
          h('button', { type: 'button', class: makesBroll ? 'btn btn-small' : 'btn btn-primary btn-small', onclick: () => file.click() }, 'Upload a video'),
          file,
          broll ? h('button', { type: 'button', class: 'btn btn-small', onclick: remove }, 'Remove b-roll') : null,
          broll?.status === 'ready' ? h('button', { type: 'button', class: 'link-btn small', onclick: () => (brollDrafts.delete(qid), brollFull.delete(qid), drawAnswer(qid)) }, 'Cancel') : null,
        ),
        makesBroll
          ? brollModel && h('p', { class: 'hint' }, `model: ${brollModel}`)
          : h('p', { class: 'hint' }, `A video of your own. Say above what it shows, and it's cut in where you talk about it, beside your answer while it plays; then you can choose where. Tick Full screen before uploading to have it fill the frame instead, with your answer in the corner.`),
      );
      el.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!submit) return;
        action(async () => {
          const res = await api('POST', `/api/questions/${qid}/broll`, { prompt: text.value });
          brollDrafts.delete(qid);
          brollFull.delete(qid);
          set(res.broll);
        })({ currentTarget: submit });
      });
      return el;
    };
    const head = (...extra) => h('div', { class: 'broll-head' }, h('span', { class: 'broll-label' }, 'B-roll'), extra);
    const described = broll?.prompt ? h('span', { class: 'broll-prompt' }, `“${broll.prompt}”`) : null;
    const uploaded = broll?.upload ? h('span', { class: 'broll-file' }, broll.upload) : null;

    const up = brollUploads.get(qid);
    if (up) {
      // Cancel stops sending it; once it's all sent, the server's getting it ready.
      const bar = h('progress', { class: 'broll-progress', max: 1, value: up.sent });
      const said = h('span', { class: 'muted small' });
      up.show = () => {
        bar.value = up.sent;
        said.textContent = up.sent < 1 ? `Uploading… ${Math.floor(up.sent * 100)}%` : 'Getting your video ready…';
      };
      up.show();
      const cancel = up.sent < 1 ? h('button', { type: 'button', class: 'link-btn small', onclick: () => up.stop.abort() }, 'Cancel') : null;
      setChildren(box, head(h('span', { class: 'broll-file' }, up.name)), bar, h('div', { class: 'row gap-sm wrap' }, said, cancel));
    } else if (!broll) {
      setChildren(box, head(), form());
    } else if (broll.status === 'pending') {
      if (!brollWatched.has(qid)) {
        brollWatched.add(qid);
        watchQuestion(qid, right, (q) => q.broll?.status !== 'pending', (q) => {
          brollWatched.delete(qid);
          if (brolls.get(qid)?.status === 'pending') set(q.broll);
        });
      }
      const doing = broll.upload ? 'Finding the best place for your video…' : 'Making your b-roll and finding the best place for it… This takes a few minutes; you can keep working.';
      setChildren(box, head(described, uploaded), h('div', { class: 'row gap-sm wrap' }, h('span', { class: 'muted small' }, doing), h('button', { type: 'button', class: 'link-btn small', onclick: remove }, 'Cancel')));
    } else if (broll.status === 'failed') {
      const why = broll.upload ? "⚠ Your video couldn't be used. Upload it again, or try another." : "⚠ This b-roll couldn't be made. Try again, or describe it differently.";
      setChildren(box, head(described, uploaded), h('p', { class: 'warn small' }, why), form({ again: true }));
    } else if (brollDrafts.has(qid)) {
      setChildren(box, head(described, uploaded), form({ again: true }));
    } else {
      const change = h('button', { type: 'button', class: 'btn btn-small', onclick: () => (brollDrafts.set(qid, broll.prompt ?? ''), brollFull.set(qid, broll.full), drawAnswer(qid)) }, 'Change');
      const chosen = broll.chosen != null;
      const where = broll.start != null
        ? h('span', { class: 'muted small' }, `Cut in ${broll.full ? 'full screen ' : ''}at ${fmtDuration(broll.start)}–${fmtDuration(broll.start + broll.length)}, ${chosen ? 'where you chose' : "where it fits what you're saying"}. Play your answer to see it.`)
        : chosen
          ? h('p', { class: 'warn small' }, `⚠ There's no room for b-roll after ${fmtDuration(broll.chosen)}, where you chose. Pick an earlier moment, or let the moderator choose.`)
          : h('p', { class: 'warn small' }, `⚠ This answer is too short for its b-roll, so it’s left out. Re-record a longer answer${broll.upload ? '' : ', or make new b-roll to fit this one'}.`);
      // Not all of a video they uploaded plays when it's longer than the time left in the answer.
      const cut = broll.upload && broll.start != null && broll.clipLength > broll.length + 0.5
        ? h('span', { class: 'muted small' }, `Only ${fmtDuration(broll.length)} of your ${fmtDuration(broll.clipLength)} video fits before your answer ends.`)
        : null;
      // Where it cuts in: where the answer's video is, which they play, scrub or click the transcript to.
      const here = h('button', { type: 'button', class: 'btn btn-small', onclick: patch(() => ({ start: Math.round(video.currentTime * 1000) / 1000 })) }, 'Cut in here');
      const auto = chosen ? h('button', { type: 'button', class: 'link-btn small', onclick: patch(() => ({ start: null })) }, 'Let the moderator choose') : null;
      const pick = h('p', { class: 'hint' }, 'Play your answer, or click a line of its transcript, to where the b-roll should start, then press Cut in here.');
      // Full screen, it can keep playing past the end of the answer, which gets longer.
      const past = h('input', { type: 'checkbox', checked: broll.pastEnd, onchange: patch(() => ({ pastEnd: past.checked })) });
      const pastEnd = broll.upload && broll.full ? h('div', {}, h('label', { class: 'check' }, past, ' Keep playing past the end of my answer'), h('p', { class: 'hint' }, 'Your answer gets longer, silent under your video.')) : null;
      // What was filmed, which may be a scene standing for the idea they described.
      const shot = broll.shot && broll.shot !== broll.prompt ? h('details', { class: 'broll-shot small' }, h('summary', {}, 'What was filmed'), h('p', {}, broll.shot)) : null;
      setChildren(
        box,
        head(described, uploaded),
        where,
        cut,
        h('div', { class: 'row gap-sm wrap' }, here, auto),
        pick,
        pastEnd,
        shot,
        h('div', { class: 'row gap-sm wrap' }, change, h('button', { type: 'button', class: 'btn btn-small', onclick: remove }, 'Remove')),
      );
    }
    return box;
  }

  // Uploads a video the expert picked as a question's b-roll, with what they typed as what it shows,
  // full screen or split screen. The server then gets it ready, in a few seconds, and places it.
  async function uploadBroll(qid, file, description, full) {
    if (file.type && !file.type.startsWith('video/')) return toast('Choose a video file.', 'error');
    if (file.size > MAX_BROLL_UPLOAD) return toast('That video is too large: b-roll can be up to 500 MB. Trim it, or export it smaller.', 'error');
    const up = { name: file.name, sent: 0, stop: new AbortController(), show: null };
    brollUploads.set(qid, up);
    drawAnswer(qid);
    const query = new URLSearchParams({ name: file.name });
    if (description.trim()) query.set('description', description.trim());
    if (full) query.set('full', '1');
    try {
      const res = await sendFile('PUT', `/api/questions/${qid}/broll/video?${query}`, file, {
        signal: up.stop.signal,
        progress: (sent) => {
          const all = sent >= 1 && up.sent < 1;
          up.sent = sent;
          if (all) drawAnswer(qid); // it can't be cancelled from here on
          else up.show?.();
        },
      });
      brollDrafts.delete(qid);
      brollFull.delete(qid);
      brolls.set(qid, res.broll);
      if (res.trimmed) toast(`Your video is ${fmtDuration(res.trimmed.from)} long, and b-roll can be up to ${fmtDuration(res.trimmed.to)}, so its start is used.`);
    } catch (err) {
      if (err.status === 401) requireLogin();
      else if (err.name !== 'AbortError') toast(`Couldn't add your video: ${err.message}`, 'error');
    } finally {
      brollUploads.delete(qid);
      drawAnswer(qid);
    }
  }

  // Starts a session at `qid` and carries on down the answer order from there.
  async function startSession(qid) {
    const n = queue.indexOf(qid) + 1;
    if (hasAnswer(qid) && !confirm(`Question ${n} already has a recorded answer. If you answer it again, the new answer replaces it.\n\nStart here anyway?`)) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined' || typeof AudioContext === 'undefined') {
      throw new Error("This browser can't record video. Try a recent Chrome, Firefox or Safari.");
    }
    let camera;
    try {
      camera = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    } catch (err) {
      throw new Error(err.name === 'NotAllowedError' ? 'Allow camera and microphone access to record your answers.' : `Couldn't start the camera: ${err.message}`);
    }
    session = recordingSession(queue.slice(n - 1), camera);
  }

  function recordingSession(order, camera) {
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

    let index = 0; // into `order`
    let take = null; // the current question's recording: { qid, loading, recorder, source, started, answering, answerStart, exiting }
    const answered = new Set(); // questions answered in this session

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

    // A question asked on camera also plays its video, muted, over the camera preview while its
    // sound plays. It loads ahead like the sound; one that's slow to load shows up when it can.
    const clips = new Map(); // video URL -> Promise<HTMLVideoElement | null>
    function questionClip(qid) {
      const url = questions.get(qid).askerVideo;
      if (!url) return Promise.resolve(null);
      if (!clips.has(url)) {
        const clip = markUpright(h('video', { class: 'studio-pip-video', src: url, preload: 'auto', playsinline: true }));
        clip.muted = true; // its sound is the question's audio, played (and recorded) with it
        clip.addEventListener('playing', () => clip.parentNode === pip && (pip.hidden = false));
        clips.set(url, new Promise((resolve) => {
          const timer = setTimeout(() => resolve(clip), 10_000);
          clip.addEventListener('canplay', () => (clearTimeout(timer), resolve(clip)), { once: true });
          clip.addEventListener('error', () => (clearTimeout(timer), resolve(null)), { once: true });
        }));
      }
      return clips.get(url);
    }
    function showClip(clip) {
      setChildren(pip, clip, clip ? h('span', { class: 'studio-pip-label' }, askerLabel(questions.get(take.qid))) : null);
      // Hidden until it has a picture (one slow to load would otherwise be an empty black box).
      pip.hidden = !clip || clip.readyState < 2;
    }
    function hideClip() {
      pip.querySelector('video')?.pause();
      showClip(null);
    }

    const dialog = h('dialog', { class: 'studio', 'aria-label': 'Recording answers' });
    // Esc mustn't end a recording by accident: it asks, like Exit (and a second Esc goes back to recording).
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (take?.exiting) keepRecording();
      else if (take) exit();
    });
    const preview = h('video', { class: 'answer-video live', autoplay: true, playsinline: true });
    preview.muted = true; // don't play the mic back into the room
    preview.srcObject = camera;
    const clock = h('span', {}, '0:00');
    const badge = h('span', { class: 'rec-badge' }, '● REC ', clock);
    const pip = h('div', { class: 'studio-pip', hidden: true }); // the asker, while a question asked on camera plays
    const panel = h('div', { class: 'studio-panel' });
    dialog.append(h('div', { class: 'live-wrap' }, preview, badge, pip), panel);
    document.body.append(dialog);
    dialog.showModal();

    const timer = setInterval(() => {
      if (!take || take.loading || take.exiting) return;
      const secs = (performance.now() - take.started) / 1000;
      clock.textContent = fmtDuration(secs);
      if (secs >= MAX_RECORDING_SECS) {
        toast(`Answers are limited to ${MAX_RECORDING_SECS / 60} minutes each, so recording stopped`, 'error');
        endTake(true);
        close();
      }
    }, 250);

    // Records one question: plays it, then the expert answers. Recording waits until the question's
    // audio is ready (usually it already is: it's fetched while the previous question is answered).
    async function startTake() {
      const qid = order[index];
      const current = { qid, loading: true, recorder: null, source: null, started: 0, answering: false, answerStart: null, exiting: false, keep: false };
      take = current;
      draw();
      const [buffer, clip] = await Promise.all([questionSound(qid), questionClip(qid)]);
      if (take !== current) return; // skipped or exited while it loaded
      if (index + 1 < order.length) {
        questionSound(order[index + 1]);
        questionClip(order[index + 1]);
      }
      const chunks = [];
      const recorder = (current.recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 }));
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        if (!current.keep) return;
        finishing -= 1;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        upload(qid, { blob, url: URL.createObjectURL(blob), answerStart: current.answerStart });
      };
      const answering = (played) => {
        if (take !== current || current.answering) return;
        current.answering = true;
        hideClip();
        if (played) current.answerStart = (performance.now() - current.started) / 1000;
        draw();
      };
      ctx.resume().catch(() => {});
      current.loading = false;
      recorder.start(1000);
      current.started = performance.now();
      clock.textContent = '0:00';
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
      draw();
    }

    // Ends the current take, keeping it as the question's answer only if `keep` and they've started answering.
    function endTake(keep) {
      hideClip();
      if (take.source) {
        take.source.onended = null;
        take.source.stop();
      }
      take.keep = keep && take.answering;
      if (take.keep) {
        answered.add(take.qid);
        finishing += 1;
      }
      take.recorder?.stop(); // a take still loading hasn't started recording
      take = null;
    }

    function advance() {
      index += 1;
      if (index < order.length) startTake();
      else close();
    }

    const next = () => (endTake(true), advance());
    const skip = () => (endTake(false), advance());
    const restart = () => (endTake(false), startTake());

    // Exiting asks whether to keep the answer in progress; recording pauses while they decide.
    // Before they've started answering there's nothing to keep, so it just exits.
    function exit() {
      if (!take.answering) return close();
      take.recorder.pause();
      take.exiting = performance.now();
      draw();
    }

    function keepRecording() {
      take.started += performance.now() - take.exiting; // the pause isn't part of the take
      take.exiting = false;
      take.recorder.resume();
      draw();
    }

    function finishExit(keep) {
      endTake(keep);
      close();
    }

    function close() {
      clearInterval(timer);
      if (take) endTake(false); // leaving the page mid-take
      camera.getTracks().forEach((t) => t.stop());
      ctx.close().catch(() => {});
      dialog.close();
      dialog.remove();
      if (session?.close === close) session = null;
      if (answered.size) toast(`${answered.size} answer${answered.size === 1 ? '' : 's'} recorded`, 'success');
    }

    function draw() {
      if (!take) return;
      const q = questions.get(take.qid);
      const last = index === order.length - 1;
      const upNext = last ? null : questions.get(order[index + 1]);
      const saving = [...uploads.values()].filter((t) => !t.failed).length;
      const warning = (text) => h('p', { class: 'warn small' }, `⚠ ${text}`);
      setChildren(badge, take.loading ? '○ GETTING READY' : take.exiting ? '❚❚ PAUSED ' : '● REC ', take.loading ? null : clock);
      setChildren(
        panel,
        h(
          'div',
          { class: 'row space-between gap-sm wrap' },
          h('span', { class: 'studio-step' }, `Question ${queue.indexOf(take.qid) + 1} · ${index + 1} of ${order.length} in this session`),
          saving ? h('span', { class: 'muted small' }, `Saving ${saving} answer${saving === 1 ? '' : 's'}…`) : null,
        ),
        h('p', { class: 'studio-q' }, q.body),
        questionMeta(q),
        hasAnswer(take.qid) ? warning(`This question already has an answer. Answering it again replaces it; ${last ? 'exiting without saving' : 'Skip'} keeps it.`) : null,
        h('p', { class: `studio-status${take.answering ? ' is-answering' : ''}` }, take.loading ? 'Loading the question…' : take.answering ? '● Your answer' : 'Playing the question…'),
        take.exiting
          ? h(
              'div',
              { class: 'studio-exit' },
              h('p', {}, 'Save your answer to this question before exiting?'),
              h(
                'div',
                { class: 'row gap-sm wrap' },
                h('button', { class: 'btn btn-primary', onclick: () => finishExit(true) }, 'Save'),
                h('button', { class: 'btn btn-outline', onclick: () => finishExit(false) }, 'Discard'),
                h('button', { class: 'link-btn', onclick: keepRecording }, 'Keep recording'),
              ),
            )
          : [
              h(
                'div',
                { class: 'row gap-sm wrap' },
                take.answering ? h('button', { class: 'btn btn-primary', onclick: next }, 'Save') : null,
                // On the last question, skipping is the same as exiting without saving.
                last ? null : h('button', { class: 'btn btn-outline', onclick: skip, title: "Leave this question's answer as it is and play the next one" }, 'Skip →'),
                h('button', { class: 'btn btn-outline', onclick: restart, title: 'Play the question again and redo your answer' }, '↺ Start over'),
                h('button', { class: 'btn btn-outline', onclick: exit }, 'Exit'),
              ),
              take.answering ? h('p', { class: 'hint' }, last ? 'Save keeps this answer and ends the session.' : 'Save keeps this answer and plays the next question.') : null,
            ],
        upNext
          ? h('div', { class: 'studio-next' }, h('span', { class: 'muted small' }, 'Up next'), h('p', {}, upNext.body), hasAnswer(upNext.id) ? warning('Already answered. Answering it again replaces that answer; Skip keeps it.') : null)
          : h('p', { class: 'muted small' }, 'This is the last question in your answer order.'),
        h('p', { class: 'hint' }, "Wear headphones, so your microphone doesn't pick up the question a second time."),
      );
      panel.querySelector('.btn-primary')?.focus();
    }

    startTake();
    return { close, draw };
  }

  const left = h('div', { class: 'plan-col' });
  const right = h('div', { class: 'plan-col' });

  function renderPlan() {
    const queued = new Set(queue);
    setChildren(left,
      h(
        'div',
        { class: 'plan-col-head' },
        h('div', {}, h('h2', {}, 'Suggested order'), h('p', { class: 'muted small' }, 'Moderator mix of popularity and topic flow; similar questions grouped. Drag one into your answer order, or click Add.')),
        h(
          'button',
          {
            class: 'btn btn-outline',
            disabled: questions.size === 0,
            onclick: () => {
              if (queue.length && !confirm('Replace your current answer order with the suggested order?')) return;
              queue = [...data.plan.suggestedOrder];
              markDirty();
              renderPlan();
            },
          },
          'Use suggested order',
        ),
      ),
      data.groups.length === 0 ? empty('No questions yet.') : null,
      data.groups.map((g) =>
        h(
          'div',
          { class: 'plan-group' },
          h('div', { class: 'group-head' }, h('h3', {}, g.label), h('span', { class: 'muted small' }, `${g.popularity} interest`)),
          g.questions.map((q) => {
            const row = h(
              'div',
              { class: `plan-q${queued.has(q.id) ? ' is-queued' : ''}`, draggable: queued.has(q.id) ? null : 'true' },
              h('span', { class: 'plan-votes' }, `▲ ${q.votes}`),
              h('div', { class: 'q-main' }, h('p', { class: 'q-body' }, q.body), questionMeta(q)),
              queued.has(q.id)
                ? h('span', { class: 'queued-pill' }, `#${queue.indexOf(q.id) + 1}`)
                : h(
                    'button',
                    {
                      class: 'btn btn-small',
                      onclick: () => {
                        queue.push(q.id);
                        markDirty();
                        renderPlan();
                      },
                    },
                    'Add',
                  ),
            );
            if (!queued.has(q.id)) {
              row.addEventListener('dragstart', (e) => startDrag(e, q.id, row));
              row.addEventListener('dragend', endDrag);
            }
            return row;
          }),
        ),
      ),
    );

    // Keyboard alternative to dragging: focus an item's handle and press ↑/↓.
    const move = (i, delta) => {
      const j = i + delta;
      if (j < 0 || j >= queue.length) return;
      [queue[i], queue[j]] = [queue[j], queue[i]];
      markDirty();
      renderPlan();
      right.querySelectorAll('.drag-handle')[j]?.focus();
    };

    queueList = h(
      'div',
      { class: 'queue-list' },
      queue.length === 0 ? empty('Drag questions here from the suggested order, or use it wholesale.') : null,
      queue.map((qid, i) => {
        const q = questions.get(qid);
        // A span, not a button: Firefox won't start a drag from inside a <button>.
        const handle = h('span', { class: 'drag-handle', tabindex: '0', role: 'button', title: 'Drag to reorder (or focus and press ↑/↓)', 'aria-label': `Reorder question ${i + 1}` }, '⠿');
        handle.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            move(i, e.key === 'ArrowUp' ? -1 : 1);
          }
        });
        const head = h(
          'div',
          { class: 'queue-head', draggable: 'true' },
          handle,
          h('span', { class: 'queue-num' }, i + 1),
          questionText(q),
          h(
            'button',
            {
              class: 'icon-btn',
              title: 'Remove from answer order',
              onclick: () => {
                queue.splice(i, 1);
                markDirty();
                renderPlan();
              },
            },
            '✕',
          ),
        );
        const item = h('div', { class: 'queue-item' }, head, questionMeta(q), answerBox(qid));
        // Only the header is draggable, so the video controls still work; the whole card is
        // used as the drag image.
        head.addEventListener('dragstart', (e) => {
          const r = item.getBoundingClientRect();
          e.dataTransfer.setDragImage(item, e.clientX - r.left, e.clientY - r.top);
          startDrag(e, qid, item);
        });
        head.addEventListener('dragend', endDrag);
        return item;
      }),
    );

    setChildren(right,
      h(
        'div',
        { class: 'plan-col-head' },
        h('div', {}, h('h2', {}, 'Your answer order'), h('p', { class: 'muted small' }, 'Drag to reorder. Only questions here with a recorded answer get published, in this order.')),
        // From the top; "Answer from here" on a question starts anywhere else.
        h('button', { class: 'btn btn-primary', disabled: queue.length === 0, onclick: action(() => startSession(queue[0])) }, '● Start answering'),
      ),
      queueList,
    );
  }

  // ----- drag and drop -----
  // Native HTML5 DnD: the browser auto-scrolls near the window edges, which a long list of
  // answer boxes needs. Drops land wherever the placeholder is in the answer order.
  let queueList = null;
  let dragged = null; // id of the question being dragged
  const placeholder = h('div', { class: 'drop-placeholder' });

  function startDrag(e, qid, el) {
    dragged = qid;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(qid)); // Firefox won't start a drag without data
    placeholder.style.height = `${el.classList.contains('queue-item') ? el.offsetHeight : 64}px`;
    // Collapse the original on the next frame (doing it synchronously cancels the drag in
    // Chrome) so the placeholder visibly takes its slot.
    if (el.classList.contains('queue-item')) requestAnimationFrame(() => el.classList.add('is-dragging'));
  }

  function endDrag() {
    dragged = null;
    placeholder.remove();
    right.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
  }

  right.addEventListener('dragover', (e) => {
    if (dragged == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const before = [...queueList.querySelectorAll('.queue-item:not(.is-dragging)')].find((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (before) {
      if (placeholder.nextElementSibling !== before) queueList.insertBefore(placeholder, before);
    } else if (queueList.lastElementChild !== placeholder) {
      queueList.append(placeholder);
    }
  });

  right.addEventListener('dragleave', (e) => {
    if (!right.contains(e.relatedTarget)) placeholder.remove();
  });

  right.addEventListener('drop', (e) => {
    if (dragged == null || !placeholder.isConnected) return;
    e.preventDefault();
    const index = [...queueList.children].filter((el) => el === placeholder || el.matches('.queue-item:not(.is-dragging)')).indexOf(placeholder);
    const next = queue.filter((id) => id !== dragged);
    next.splice(index, 0, dragged);
    const changed = next.join() !== queue.join();
    queue = next;
    endDrag();
    if (changed) markDirty();
    renderPlan();
  });

  renderPlan();

  const seedPanel = oh.status === 'open' ? suggestionPanel(oh) : null;

  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'card oh-header' },
      h('div', { class: 'row gap-sm wrap space-between' }, topicChip(oh), h('a', { class: 'btn btn-outline', href: `#/oh/${oh.id}` }, 'View public page')),
      h('h1', {}, oh.title),
      h('p', { class: 'muted small' }, `Answers expected ${fmtDate(oh.answersExpectedAt)}`, h('br'), `moderator: ${data.moderator}`),
      oh.status === 'open'
        ? h(
            'div',
            { class: 'row gap-sm wrap' },
            h(
              'button',
              {
                class: 'btn btn-outline',
                onclick: action(async () => {
                  if (!confirm('Stop accepting questions and votes now?')) return;
                  await api('POST', `/api/office-hours/${oh.id}/close`);
                  render();
                }),
              },
              'Close questions now',
            ),
          )
        : null,
    ),
    seedPanel,
    h('div', { class: 'plan' }, left, right),
    h(
      'div',
      { class: 'savebar' },
      saveState,
      publishBtn,
    ),
  );
}

function suggestionPanel(oh) {
  let round = 0;
  const shown = [];
  const list = h('div', { class: 'suggestions' });
  const addBtn = h('button', { class: 'btn btn-primary', hidden: true }, 'Add selected to off hours');

  const fetchMore = action(async () => {
    list.prepend(h('p', { class: 'muted small loading-line' }, 'Moderator is thinking…'));
    try {
      const { questions } = await api('POST', `/api/office-hours/${oh.id}/suggestions`, { round, exclude: shown });
      round += 1;
      shown.push(...questions);
      for (const q of questions) {
        const box = h('input', { type: 'checkbox', checked: true, value: q });
        list.append(h('label', { class: 'suggestion' }, box, h('span', {}, q)));
      }
      addBtn.hidden = list.querySelectorAll('input').length === 0;
      if (!questions.length) toast('The moderator is out of ideas — try adding expertise to your profile', 'info');
    } finally {
      list.querySelector('.loading-line')?.remove();
    }
  });

  addBtn.addEventListener(
    'click',
    action(async () => {
      const picked = [...list.querySelectorAll('input:checked')].map((i) => i.value);
      if (!picked.length) return toast('Select at least one question');
      await api('POST', `/api/office-hours/${oh.id}/seed`, { questions: picked });
      toast(`Added ${picked.length} seed question${picked.length === 1 ? '' : 's'}`, 'success');
      render();
    }),
  );

  return h(
    'section',
    { class: 'card seed' },
    h('div', { class: 'row space-between wrap gap-sm' }, h('div', {}, h('h2', {}, '✦ Seed your off hours'), h('p', { class: 'muted small' }, 'The moderator suggests questions from your bio, expertise and topic. Seeds appear as "Suggested by moderator" and can be +1\'d like any question.')), h('button', { class: 'btn btn-outline', onclick: fetchMore }, 'Suggest questions')),
    list,
    h('div', { class: 'row gap-sm' }, addBtn),
  );
}

// Prefer MP4 (plays in every browser) where the browser can record it; Firefox records WebM.
const RECORDING_TYPES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const MAX_RECORDING_SECS = 600;
// Same preference for spoken questions; Firefox records Ogg or WebM.
const AUDIO_RECORDING_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/ogg'];
const MAX_QUESTION_SECS = 90;

// Announcing office hours. With `?followUp=<id>`, a follow-up to one of the expert's published
// office hours: its details are filled in, and questions the moderator took from its discussion
// can be picked (and reworded) to start the new one with, as seed questions.
async function newOfficeHourPage(_, query) {
  const followUp = query.get('followUp') ? (await api('GET', `/api/office-hours/${encodeURIComponent(query.get('followUp'))}/follow-up`)).followUp : null;
  const deadline = new Date(Date.now() + 3 * 86400_000);
  deadline.setHours(17, 0, 0, 0);
  const answers = new Date(deadline.getTime() + 2 * 86400_000);

  const f = {
    title: h('input', { required: true, maxlength: 120, placeholder: 'e.g. Ask me anything about breaking into product design', value: followUp?.title }),
    topic: h('input', { maxlength: 60, placeholder: 'Optional — e.g. Career growth', value: followUp?.topic }),
    description: h('textarea', { rows: followUp ? 5 : 3, maxlength: 2000, placeholder: 'What should people ask about? Anything off-limits?', value: followUp?.description }),
    deadline: h('input', { type: 'datetime-local', required: true, value: toLocalInput(deadline) }),
    answers: h('input', { type: 'datetime-local', required: true, value: toLocalInput(answers) }),
    anon: h('input', { type: 'checkbox', checked: followUp?.allowAnonymous }),
  };
  const picks = (followUp?.questions ?? []).map((q) => ({ box: h('input', { type: 'checkbox', checked: true, 'aria-label': 'Include this question' }), text: h('textarea', { rows: 2, value: q, maxlength: 500, 'aria-label': 'Question' }) }));
  const fromDiscussion = followUp
    ? h(
        'fieldset',
        { class: 'follow-up-questions' },
        h('legend', {}, 'Questions from the discussion'),
        picks.length
          ? [
              h('p', { class: 'hint' }, 'Ticked questions start the follow-up as suggested questions, which people can +1. Reword them as you like.'),
              picks.map(({ box, text }) => h('div', { class: 'suggestion' }, box, text)),
            ]
          : h('p', { class: 'hint' }, 'The discussion didn’t raise any questions to pick up. You can still ask the moderator for seed questions once it’s announced.'),
      )
    : null;
  const form = h(
    'form',
    { class: 'card form' },
    followUp ? h('p', { class: 'muted small' }, 'Follows up on ', h('a', { href: `#/oh/${followUp.followUpOf.id}` }, followUp.followUpOf.title)) : null,
    h('label', {}, 'Title', f.title),
    h('label', {}, 'Topic', f.topic),
    h('label', {}, 'Description', f.description),
    h('div', { class: 'row gap wrap' }, h('label', { class: 'grow' }, 'Questions due by', f.deadline), h('label', { class: 'grow' }, 'Answers expected', f.answers)),
    h('label', { class: 'check' }, f.anon, ' Allow anonymous questions'),
    fromDiscussion,
    me.expertise.length === 0 ? h('p', { class: 'notice' }, 'Tip: ', h('a', { href: `#/u/${me.username}` }, 'add your expertise and bio'), ' so the moderator can suggest better seed questions.') : null,
    h('div', { class: 'row gap-sm' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Announce off hours')),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    action(async () => {
      const { officeHour } = await api('POST', '/api/office-hours', {
        title: f.title.value,
        topic: f.topic.value,
        description: f.description.value,
        questionsDeadline: new Date(f.deadline.value).toISOString(),
        answersExpectedAt: new Date(f.answers.value).toISOString(),
        allowAnonymous: f.anon.checked,
        followUpOf: followUp?.followUpOf.id,
        questions: followUp ? picks.filter(({ box, text }) => box.checked && text.value.trim()).map(({ text }) => text.value) : undefined,
      });
      toast('Announced! Your subscribers will see it in their feed.', 'success');
      go(`#/oh/${officeHour.id}/manage`);
    })({ currentTarget: form.querySelector('button[type=submit]') });
  });
  return h('div', { class: 'narrow' }, h('h1', {}, followUp ? 'Follow-up Q&A' : 'Host off hours'), form);
}

async function profilePage({ username }) {
  const data = await api('GET', `/api/users/${encodeURIComponent(username)}`);
  const u = data.user;
  const upcoming = data.officeHours.filter((oh) => oh.status !== 'published');
  const past = data.officeHours.filter((oh) => oh.status === 'published');

  const header = h(
    'div',
    { class: 'card profile' },
    h('div', { class: 'row gap' }, h('span', { class: 'avatar avatar-lg' }, u.displayName.charAt(0).toUpperCase()), h('div', {}, h('h1', {}, u.displayName), h('p', { class: 'muted small' }, `@${u.username} · ${data.subscriberCount} subscriber${data.subscriberCount === 1 ? '' : 's'}`))),
    u.bio ? h('p', { class: 'desc' }, u.bio) : null,
    u.expertise.length ? h('div', { class: 'row gap-sm wrap' }, u.expertise.map((t) => h('span', { class: 'chip' }, t))) : null,
    data.isMe ? null : subscribeButton({ type: 'expert', id: u.id, subscribed: data.subscribed }),
  );

  return h(
    'div',
    { class: 'stack' },
    header,
    data.isMe ? profileEditor(u) : null,
    h('section', {}, h('h2', { class: 'section-title' }, 'Upcoming & open'), upcoming.length ? h('div', { class: 'grid' }, upcoming.map(ohCard)) : empty('No upcoming off hours.', data.isMe ? h('a', { class: 'btn btn-outline', href: '#/oh/new' }, 'Host one') : null)),
    past.length ? h('section', {}, h('h2', { class: 'section-title' }, 'Answered'), h('div', { class: 'grid' }, past.map(ohCard))) : null,
  );
}

function profileEditor(u) {
  const f = {
    displayName: h('input', { value: u.displayName, maxlength: 60, required: true }),
    bio: h('textarea', { rows: 3, maxlength: 1000, value: u.bio, placeholder: 'Your background — the moderator uses this to suggest questions.' }),
    expertise: h('input', { value: u.expertise.join(', '), placeholder: 'Comma-separated, e.g. distributed systems, career growth' }),
  };
  const form = h('form', { class: 'form' }, h('label', {}, 'Display name', f.displayName), h('label', {}, 'Bio', f.bio), h('label', {}, 'Expertise', f.expertise), h('div', {}, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save profile')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    action(async () => {
      ({ user: me } = await api('PATCH', '/api/me', { displayName: f.displayName.value, bio: f.bio.value, expertise: f.expertise.value }));
      toast('Profile saved', 'success');
      render();
    })({ currentTarget: form.querySelector('button') });
  });
  return h('details', { class: 'card' }, h('summary', {}, 'Edit profile'), form);
}

function loginPage(_, query) {
  const next = query.get('next') || '#/';
  let mode = 'login';
  const f = {
    username: h('input', { required: true, autocomplete: 'username', maxlength: 30 }),
    displayName: h('input', { maxlength: 60, autocomplete: 'name' }),
    password: h('input', { type: 'password', required: true, autocomplete: 'current-password' }),
  };
  const nameRow = h('label', { hidden: true }, 'Display name', f.displayName);
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Log in');
  const toggle = h('button', { type: 'button', class: 'link-btn' }, 'New here? Create an account');
  toggle.addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    nameRow.hidden = mode === 'login';
    submit.textContent = mode === 'login' ? 'Log in' : 'Create account';
    toggle.textContent = mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in';
    f.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  });
  const form = h('form', { class: 'card form' }, h('label', {}, 'Username', f.username), nameRow, h('label', {}, 'Password', f.password), submit, toggle);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    action(async () => {
      await api('POST', `/api/auth/${mode}`, { username: f.username.value, password: f.password.value, displayName: f.displayName.value });
      if (mode === 'register') devUsers = null; // the switcher lists them next time
      await loadMe();
      go(next);
    })({ currentTarget: submit });
  });
  return h('div', { class: 'narrow' }, h('h1', {}, 'Welcome to off hours'), h('p', { class: 'muted' }, 'Ask experts questions. Host your own off hours.'), form);
}

// ---------- shell & routing ----------

// Who's logged in, their voice, and what the server can do.
async function loadMe() {
  ({ user: me, devLogin, devSession, speech, broll: brollOn, makesBroll, brollModel, voices, voice: myVoice } = await api('GET', '/api/me'));
}

// Dev-only: switch between users without logging in. Shown when the server runs with --dev, until
// someone logs in with their password.
function userSwitcher() {
  const select = h('select', { class: 'dev-switcher', title: 'Dev mode: switch user without logging in' }, h('option', { value: '' }, '— logged out —'));
  const fill = () => {
    for (const u of devUsers) select.append(h('option', { value: u.username }, `${u.displayName} (@${u.username})`));
    select.value = me?.username ?? '';
  };
  if (devUsers) fill();
  else api('GET', '/api/dev/users').then(({ users }) => ((devUsers = users), fill()), (err) => toast(err.message, 'error'));

  select.addEventListener(
    'change',
    action(async () => {
      if (select.value) {
        await api('POST', '/api/dev/login', { username: select.value });
        await loadMe();
      } else {
        await api('POST', '/api/auth/logout');
        me = null;
      }
      toast(me ? `Now acting as ${me.displayName}` : 'Logged out');
      // Stay on the current page, seen as the new user; leave the login page if we're on it.
      go(location.hash.startsWith('#/login') ? '#/' : location.hash || '#/');
    }),
  );
  return h('label', { class: 'dev-switch' }, h('span', {}, 'Acting as'), select);
}

function renderNav() {
  const link = (href, label) => h('a', { href, class: location.hash.split('?')[0] === href || (href === '#/' && !location.hash) ? 'active' : '' }, label);
  setChildren($nav,
    h('a', { href: '#/', class: 'brand' }, 'off hours'),
    h('div', { class: 'nav-links' }, me ? link('#/', 'Feed') : null, link('#/explore', 'Explore')),
    h(
      'div',
      { class: 'nav-right' },
      devLogin && (!me || devSession) ? userSwitcher() : null,
      me
        ? [
            h('a', { href: '#/oh/new', class: 'btn btn-primary btn-small' }, '+ Host'),
            h('a', { href: `#/u/${me.username}`, class: 'nav-user' }, me.displayName),
            h(
              'button',
              {
                class: 'link-btn',
                onclick: action(async () => {
                  await api('POST', '/api/auth/logout');
                  me = null;
                  go('#/explore');
                }),
              },
              'Log out',
            ),
          ]
        : h('a', { href: '#/login', class: 'btn btn-outline btn-small' }, 'Log in'),
    ),
  );
}

const ROUTES = [
  [/^#?\/?$/, feedPage, { auth: true }],
  [/^#\/explore$/, explorePage],
  [/^#\/oh\/new$/, newOfficeHourPage, { auth: true }],
  [/^#\/oh\/(?<id>\d+)$/, officeHourPage],
  [/^#\/oh\/(?<id>\d+)\/manage$/, managePage, { auth: true }],
  [/^#\/u\/(?<username>\w+)$/, profilePage],
  [/^#\/login$/, loginPage],
];

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  window.onbeforeunload = null;
  pageCleanup?.();
  pageCleanup = null;
  const [path, qs = ''] = location.hash.split('?');
  const query = new URLSearchParams(qs);
  renderNav();
  const found = ROUTES.map(([re, page, opts]) => ({ m: path.match(re), page, opts })).find((r) => r.m);
  if (!found) {
    $app.replaceChildren(empty('Page not found.', h('a', { href: '#/' }, 'Go home')));
    return;
  }
  if (found.opts?.auth && !me) {
    // Logged-out visitors land on Explore instead of an empty feed.
    if (found.page === feedPage) return go('#/explore');
    return go(`#/login?next=${encodeURIComponent(location.hash)}`);
  }
  $app.querySelectorAll('audio, video').forEach((m) => m.pause()); // removing them doesn't stop playback
  $app.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  try {
    const view = await found.page(found.m.groups ?? {}, query);
    if (seq === renderSeq) $app.replaceChildren(view);
  } catch (err) {
    if (seq !== renderSeq) return;
    if (err.status === 401) return requireLogin();
    $app.replaceChildren(empty(err.message, h('a', { href: '#/' }, 'Go home')));
  }
  window.scrollTo(0, 0);
}

// The top bar's height, which grows when it wraps on a narrow screen, for the player that docks
// under it (--topbar).
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar', `${$nav.parentElement.offsetHeight}px`)).observe($nav.parentElement);
window.addEventListener('hashchange', render);
await loadMe();
render();
