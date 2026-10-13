// forum — single-page client. No framework: a tiny h() helper and hash routing.

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
let me = null;
let devLogin = false; // server has the dev user switcher enabled
let speech = false; // server can transcribe recordings and read text aloud
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
  if (oh.status === 'closed') return h('span', { class: 'badge badge-closed' }, `Questions closed · answers expected ${fmtDate(oh.answersExpectedAt)}`);
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

function questionMeta(q) {
  const parts = [];
  if (q.askedWith === 'audio') {
    const how = q.askerVideo ? '🎥 Asked on camera' : '🎙 Asked out loud';
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
  const anonNote = h('p', { class: 'hint', hidden: true });
  let mode = 'text';
  const modeButton = (value, label) => h('button', { type: 'button', class: 'ask-mode', 'data-mode': value, 'aria-pressed': String(value === mode), onclick: () => setMode(value) }, label);
  const modes = speech ? h('div', { class: 'ask-modes', role: 'group', 'aria-label': 'How to ask' }, modeButton('text', '✎ Type'), modeButton('audio', '🎙 Speak'), modeButton('video', '🎥 Video')) : null;

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
    for (const [kind, recorder] of Object.entries(recorders)) recorder.el.hidden = kind !== mode;
    showAnonNote();
  }
  anon?.addEventListener('change', showAnonNote);
  if (speech) {
    recorderList.forEach((r) => (r.el.hidden = true));
    pageCleanup = () => recorderList.forEach((r) => r.close()); // let go of the microphone and camera on navigation
    window.onbeforeunload = () => (recorderList.some((r) => r.busy()) ? true : undefined);
  }

  const form = h(
    'form',
    { class: 'ask' },
    modes,
    textarea,
    recorderList.map((r) => r.el),
    h('div', { class: 'ask-actions' }, anon ? h('label', { class: 'check' }, anon, ' Ask anonymously') : h('span', { class: 'muted small' }, 'Your name will be shown with your question.'), submit),
    anonNote,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (mode !== 'text') return;
    action(async () => {
      const { question } = await api('POST', `/api/office-hours/${oh.id}/questions`, { body: textarea.value, anonymous: anon?.checked ?? false });
      textarea.value = '';
      toast("Question submitted — you'll be notified when it's answered", 'success');
      onAsked?.(question);
    })({ currentTarget: submit });
  });
  return form;
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

// `transcript` adds its captions as subtitles once they're ready.
function videoPlayer(src, transcript) {
  const video = fixDuration(h('video', { class: 'answer-video', src, controls: true, preload: 'metadata', playsinline: true }), { firstFrame: true });
  addCaptions(video, transcript);
  return video;
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
  const video = q.askerVideo ? h('video', { class: 'q-video', src: q.askerVideo, preload: 'none', playsinline: true, hidden: true }) : null;
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
// transcript is ready). Fills `videos` (question id -> video) for the discussion.
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
        h('div', { class: 'qa-a' }, video),
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
  const items = answers.map((q, i) =>
    h(
      'div',
      { class: 'ft-item' },
      h('p', { class: 'ft-q' }, `${i + 1}. ${q.body}`, askedBy(q) ? h('span', { class: 'muted small' }, ` — ${askedBy(q)}`) : null),
      answerBlock(oh, q, onChange),
      replyThread(oh, q),
    ),
  );
  return h('section', { class: 'card full-transcript' }, h('h2', {}, 'Discussion'), items);
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
  return h('div', { class: 'thread' }, additionList, count, list, replyOpener('Reply', `Reply to ${oh.expert.displayName}’s answer…`, 'Reply', post(replies)));
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
    userLink(r.author),
    r.byExpert ? h('span', { class: 'tag tag-expert' }, 'Expert') : null,
    r.mine ? h('span', { class: 'tag tag-you' }, 'you') : null,
    h('span', { class: 'muted small', title: fmtDate(r.createdAt) }, relative(r.createdAt)),
  );
}

function replyBody(r, ...extra) {
  return [h('p', { class: 'reply-body' }, r.body), h('div', { class: 'reply-actions' }, likeButton(r), extra)];
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
  return paragraphs.map((p) => h('p', {}, p.join(' ')));
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

// The fox, which says a question nobody asked on camera. fox.webp is the fox with its eyes and
// mouth painted out; they're drawn here instead, so it can blink and talk. Coordinates are in that
// picture's pixels.
const FOX = {
  src: '/fox.webp',
  view: [75, 90, 627, 470], // the part shown (x, y, width, height): all of it as drawn; the rest leaves room to sway
  pivot: [389.5, 1125], // its feet, below the picture: it sways and bounces on them
  ink: '#100d0b',
  shineColor: '228, 228, 225',
  // shine: the highlight's centre, radii and angle
  eyes: [
    { at: [299.1, 383.7], r: [18.3, 18.8], shine: [309.4, 375, 4.3, 2.7, 0.82] },
    { at: [479.8, 383.6], r: [18.4, 18.6], shine: [487.6, 374.3, 5.4, 3.2, 0.78] },
  ],
  mouth: { at: [390.6, 425.4], halfWidth: 25.5, sag: 10, jaw: 21, line: 5 }, // at: the bottom of its smile
};

// The fox on a canvas. `draw(pose, blink, t)` shows it with a pose from a question's lip sync,
// [open, width, energy] (see src/speech/lipsync.py), its eyes `blink` (0-1) shut, `t` seconds
// into the question, which sets its idle sway.
function fox() {
  const canvas = h('canvas', { class: 'jp-fox' });
  const ctx = canvas.getContext('2d');
  const image = new Image();
  let last = null;
  image.onload = () => last && draw(...last);
  image.src = FOX.src;

  function eye({ at: [x, y], r: [rx, ry], shine: [sx, sy, srx, sry, angle] }, blink) {
    // It blinks by squashing, as the lid comes down.
    const squash = 1 - 0.9 * blink;
    ctx.save();
    ctx.translate(x, y + 0.45 * ry * (1 - squash));
    ctx.scale(1, squash);
    ctx.fillStyle = FOX.ink;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, 2 * Math.PI);
    ctx.fill();
    if (blink < 0.6) {
      ctx.globalAlpha = 1 - blink / 0.6;
      ctx.translate(sx - x, sy - y);
      ctx.rotate(angle);
      ctx.scale(srx, sry);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      glow.addColorStop(0, `rgba(${FOX.shineColor}, 0.95)`);
      glow.addColorStop(0.6, `rgba(${FOX.shineColor}, 0.9)`);
      glow.addColorStop(1, `rgba(${FOX.shineColor}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  function mouth(open, width) {
    const { at: [mx, my], halfWidth, sag, jaw, line } = FOX.mouth;
    const hw = halfWidth * width;
    const depth = jaw * open;
    const top = my - 0.12 * depth; // the upper lip lifts a little
    const bottom = my + depth;
    // Narrow shapes (oh, oo) are round, with the corners halfway down the opening; wide ones keep
    // the smile, flattening as the jaw drops.
    const round = Math.min(1, Math.max(0, (0.85 - width) / 0.4)) * Math.min(1, 4 * open);
    const smile = my - sag * width * (1 - 0.5 * open);
    const corner = smile + ((top + bottom) / 2 - smile) * round;
    // A lip from one corner to the other through `y` in the middle: a parabola, or boxier with `box`.
    const lip = (path, from, to, y, box) => {
      const reach = ((to - from) * (1 - box)) / 3;
      const control = (4 * y - corner) / 3;
      path.bezierCurveTo(from + reach, control, to - reach, control, to, corner);
    };
    const path = new Path2D();
    path.moveTo(mx - hw, corner);
    lip(path, mx - hw, mx + hw, top, round);
    ctx.lineWidth = line;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = FOX.ink;
    if (depth < 0.5) return ctx.stroke(path);
    lip(path, mx + hw, mx - hw, bottom, 0.35 + 0.65 * round);
    path.closePath();
    ctx.save();
    ctx.clip(path);
    const inside = ctx.createLinearGradient(0, top, 0, bottom);
    inside.addColorStop(0, '#2a0f10');
    inside.addColorStop(1, '#5e2328');
    ctx.fillStyle = inside;
    ctx.fillRect(mx - hw - line, Math.min(corner, top) - line, 2 * (hw + line), bottom - Math.min(corner, top) + 2 * line);
    ctx.fillStyle = '#d9737f'; // the tongue, behind the lower lip
    ctx.beginPath();
    ctx.ellipse(mx, bottom, 0.55 * hw, Math.min(0.42 * depth, 0.3 * halfWidth), 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
    ctx.stroke(path);
  }

  function draw(pose, blink, t) {
    last = [pose, blink, t];
    const [vx, vy, vw, vh] = FOX.view;
    const w = Math.round(canvas.clientWidth * devicePixelRatio);
    if (!w || !image.naturalWidth) return;
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = Math.round((w * vh) / vw);
    }
    const [open, width, energy] = pose;
    const scale = w / vw;
    ctx.setTransform(scale, 0, 0, scale, -vx * scale, -vy * scale);
    // A slow sway and breathing, and it rises a little on the louder parts.
    const wave = (period, phase = 0) => Math.sin((2 * Math.PI * t) / period + phase);
    const [px, py] = FOX.pivot;
    const breathe = 0.005 * wave(3.4);
    ctx.translate(px, py - vh * (0.003 * wave(3.7, 0.9) + 0.014 * energy));
    ctx.rotate(((wave(5.3, 0.4) + 0.4 * wave(2.9, 1.7)) * Math.PI) / 180);
    ctx.scale(1 + breathe - 0.006 * energy, 1 + breathe + 0.012 * energy);
    ctx.translate(-px, -py);
    ctx.imageSmoothingQuality = 'high'; // it's drawn a few times smaller than it is, and fur shimmers otherwise
    ctx.drawImage(image, 0, 0);
    for (const e of FOX.eyes) eye(e, blink);
    mouth(open, width);
  }

  return { el: canvas, draw };
}

// How far shut the fox's eyes are `t` seconds into a question: it blinks every 2-5 seconds,
// at random but the same each time the question with id `seed` plays.
function blinkAt(seed, t) {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
  for (let start = 0.6 + 1.2 * random(); start <= t; start += 2.2 + 2.8 * random()) {
    const since = t - start;
    if (since < 0.07) return since / 0.07;
    if (since < 0.1) return 1;
    if (since < 0.23) return 1 - (since - 0.1) / 0.13;
  }
  return 0;
}

// The published answers as one video: the takes joined end to end on the server (src/video.js).
// It has its own controls, so captions and the asker stay on it in fullscreen. Captions are drawn
// at the bottom, except for answers whose captions are burned into the video (`captions` on their
// chapter, when the server finished it). While a question is being played, a picture at the top
// left shows who asked: the asker's video for a question asked on camera, kept in step with the
// question, and otherwise the fox saying it. `chapters` place each answer in the video, and where
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
  const stand = fox(); // stands in for an asker who wasn't on camera
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
  // Each loads while the answer before it plays, so it's ready when its question comes up.
  const faces = new Map(); // question id -> <video>
  function face(q) {
    if (!faces.has(q.id)) {
      const f = fixDuration(h('video', { class: 'jp-face', src: q.askerVideo, preload: 'metadata', playsinline: true }));
      f.muted = true;
      faces.set(q.id, f);
    }
    return faces.get(q.id);
  }
  let shownFace = null;
  const pictured = new WeakSet(); // faces that have had a frame to show
  function showFace(f, at) {
    if (f !== shownFace) {
      shownFace?.pause();
      setChildren(faceSlot, f);
      shownFace = f;
    }
    if (f) {
      // Seek only once the browser knows how long it is (see fixDuration), and when it has drifted.
      if (Number.isFinite(f.duration) && Math.abs(f.currentTime - at) > 0.3) f.currentTime = Math.min(at, f.duration);
      if (video.paused) f.pause();
      else if (f.paused && !f.ended) f.play().catch(() => {}); // it may end a moment before the question does
      // The fox stands in until the video has a picture of this moment, rather than an empty
      // black box or a first frame that then jumps. Once shown it stays, even while it seeks
      // (the last frame stays up meanwhile).
      if (f.readyState >= 2 && !f.seeking && Math.abs(f.currentTime - at) <= 0.3) pictured.add(f);
    }
    asking.classList.toggle('has-face', Boolean(f && pictured.has(f)));
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
    if (q && !asking.classList.contains('has-face')) {
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

// The Q&A in short, under the video: each question in a few words, then the main points of its
// answer. Each question and answer is one thing to click, which plays it from the question; the
// one being played is highlighted. Summaries are written once an answer is transcribed (and again
// when it's corrected), so answers still waiting for one are watched. `refresh(q)` fetches a new
// one after a correction.
function summaryTranscript(player) {
  const items = new Map(); // question id -> its button
  const watching = new Set();
  const list = h('ol', { class: 'st-list' });
  for (const part of player.parts) {
    const item = h('button', { type: 'button', class: 'st-item', title: `Play from ${fmtDuration(part.start)}`, onclick: () => player.play(part.start) });
    items.set(part.q.id, item);
    list.append(h('li', {}, item));
    draw(part);
  }

  // Spans styled as blocks: a button may only hold inline content.
  function draw(part) {
    const { q, start } = part;
    const { summary, transcript } = q;
    const by = askedBy(q);
    let note = null;
    if (transcript?.status === 'pending') note = 'A summary of the answer will appear here once it’s transcribed.';
    else if (!transcript || transcript.status === 'failed') note = "This answer couldn't be transcribed.";
    else if (!summary?.points.length) note = 'No speech was detected in this answer.';
    setChildren(
      items.get(q.id),
      h('span', { class: 'st-time' }, fmtDuration(start)),
      h(
        'span',
        { class: 'st-body' },
        h('span', { class: 'st-q' }, summary?.question ?? q.body, by ? h('span', { class: 'st-by' }, ` — ${by}`) : null),
        summary?.points.map((p) => h('span', { class: 'st-point' }, p)),
        note ? h('span', { class: 'muted small st-note' }, note) : null,
      ),
    );
    if (transcript?.status === 'pending' || summary?.pending) watch(part);
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
    el: h(
      'section',
      { class: 'card summary-transcript' },
      h('div', { class: 'row space-between gap-sm wrap' }, h('h2', {}, 'Summary'), h('span', { class: 'muted small' }, '✦ Summarized by the moderator. Click one to play it.')),
      list,
    ),
    refresh(q) {
      const part = player.parts.find((p) => p.q === q);
      api('GET', `/api/questions/${q.id}`).then(({ question }) => update(part, question), (err) => toast(err.message, 'error'));
    },
  };
}

// For the expert while their answers are being joined into one video, which takes a few minutes.
// The page shows the video as soon as it's ready.
function processingNote(oh) {
  const el = h('p', { class: 'notice' }, 'Your answers are published, and the video is being processed. It usually takes a few minutes; this page shows it as soon as it’s ready. Until then, everyone else sees this office hour as closed.');
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
    h('div', { class: 'page-head' }, h('h1', {}, 'Your feed'), h('a', { class: 'btn btn-primary', href: '#/oh/new' }, '+ Host office hours')),
    items.length === 0
      ? empty('Nothing here yet. Subscribe to experts or office hours and they\'ll show up here.', h('a', { class: 'btn btn-outline', href: '#/explore' }, 'Explore office hours'))
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
      h('div', {}, userLink(oh.expert), item.type === 'announced' ? ' announced office hours' : ` answered ${plural(item.answerCount, 'question')}`),
      h('div', { class: 'muted small' }, relative(item.at)),
    ),
  );
  const title = h('div', { class: 'feed-title' }, h('a', { href: `#/oh/${oh.id}` }, h('h2', {}, oh.title)), h('div', { class: 'row gap-sm wrap' }, topicChip(oh), item.type === 'announced' ? statusBadge(oh) : null));
  const cta = (label, primary = true) => h('div', { class: 'feed-foot' }, h('a', { class: `btn ${primary ? 'btn-primary' : 'btn-outline'}`, href: `#/oh/${oh.id}` }, label));

  if (item.type === 'announced') {
    let action;
    if (oh.status === 'published') action = cta('Read the answers →');
    else if (oh.isExpert) action = cta('View office hour →', false);
    else if (oh.status === 'open') action = cta('Ask a question →');
    else action = cta('View questions →', false);
    return h(
      'article',
      { class: 'card feed-item' },
      head,
      title,
      oh.description ? h('p', { class: 'desc clamp' }, oh.description) : null,
      h('p', { class: 'muted small' }, `${plural(oh.questionCount, 'question')} ${oh.status === 'open' ? 'so far' : 'asked'} · questions until ${fmtDate(oh.questionsDeadline)} · answers expected ${fmtDate(oh.answersExpectedAt)}`),
      action,
    );
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
    h('div', { class: 'page-head' }, h('h1', {}, 'Explore'), me ? h('a', { class: 'btn btn-primary', href: '#/oh/new' }, '+ Host office hours') : null),
    h('section', {}, h('h2', { class: 'section-title' }, 'Taking questions now'), open.length ? h('div', { class: 'grid' }, open.map(ohCard)) : empty('No office hours are open right now.')),
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
            h('p', { class: 'muted small' }, `@${p.username} · ${p.subscribers} subscriber${p.subscribers === 1 ? '' : 's'} · ${p.hosted} office hour${p.hosted === 1 ? '' : 's'}`),
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
    h('p', { class: 'muted' }, 'with ', userLink(oh.expert)),
    oh.followUpOf ? h('p', { class: 'muted small' }, 'Follows up on ', h('a', { href: `#/oh/${oh.followUpOf.id}` }, oh.followUpOf.title)) : null,
    oh.description ? h('p', { class: 'desc' }, oh.description) : null,
    data.followUps.length ? h('p', { class: 'muted small' }, 'Followed up in ', data.followUps.map((f, i) => [i ? ', ' : null, h('a', { href: `#/oh/${f.id}` }, f.title)])) : null,
    h(
      'dl',
      { class: 'facts' },
      h('div', {}, h('dt', {}, 'Questions until'), h('dd', {}, fmtDate(oh.questionsDeadline))),
      h('div', {}, h('dt', {}, 'Answers expected'), h('dd', {}, fmtDate(oh.answersExpectedAt))),
      h('div', {}, h('dt', {}, 'Questions'), h('dd', {}, oh.questionCount)),
    ),
    h(
      'div',
      { class: 'row gap-sm wrap' },
      oh.isExpert && oh.status !== 'published' ? h('a', { class: 'btn btn-primary', href: `#/oh/${oh.id}/manage` }, 'Plan & answer') : null,
      oh.isExpert && oh.status === 'published' && !oh.processing ? h('a', { class: 'btn btn-outline', href: `#/oh/new?followUp=${oh.id}` }, 'Create follow-up Q&A') : null,
      !oh.isExpert ? subscribeButton({ type: 'office_hour', id: oh.id, subscribed: oh.subscribed, label: 'this office hour' }) : null,
      !oh.isExpert ? subscribeButton({ type: 'expert', id: oh.expert.id, subscribed: oh.subscribedToExpert, label: oh.expert.displayName }) : null,
    ),
  );

  // While the answers are being joined into one video, the page stays as it was when questions
  // closed (readers see it as closed); the expert gets a note, and the page updates once it's ready.
  if (oh.status === 'published' && !oh.processing) {
    const answeredIds = new Set(data.answers.map((q) => q.id));
    const rest = data.groups.flatMap((g) => g.questions).filter((q) => !answeredIds.has(q.id));
    const title = h('h2', { class: 'section-title' }, `${data.answers.length} answered question${data.answers.length === 1 ? '' : 's'}`);
    const unanswered = rest.length
      ? h('details', { class: 'card' }, h('summary', {}, `${rest.length} question${rest.length === 1 ? ' was' : 's were'} not answered`), h('ul', { class: 'q-list' }, rest.map((q) => questionRow(q, { canVote: false }))))
      : null;
    if (data.video?.status === 'ready') {
      // One video, with a short transcript to find your way around it. The full one is folded away.
      const player = jointPlayer(data.answers, data.video);
      const summary = summaryTranscript(player);
      const onChange = (q) => (player.update(q), summary.refresh(q));
      return h('div', { class: 'stack' }, header, h('section', {}, title, player.el, summary.el), discussion(oh, data.answers, onChange), unanswered);
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
    ? data.groups.map((g) => h('section', { class: 'card group' }, h('div', { class: 'group-head' }, h('h3', {}, g.label), h('span', { class: 'muted small' }, `${g.questions.length} question${g.questions.length === 1 ? '' : 's'}`)), h('ul', { class: 'q-list' }, g.questions.map((q) => questionRow(q, { canVote })))))
    : [empty(oh.status === 'open' ? 'No questions yet — be the first to ask.' : 'No questions were asked.')];

  return h(
    'div',
    { class: 'stack' },
    header,
    oh.processing ? processingNote(oh) : null,
    oh.status === 'open' && !oh.isExpert ? h('div', { class: 'card' }, askForm(oh, () => render())) : null,
    h('div', { class: 'row space-between' }, h('h2', { class: 'section-title' }, 'Questions'), h('span', { class: 'muted small', title: 'Similar questions are grouped by the moderator' }, '✦ grouped by the moderator')),
    groups,
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
  window.onbeforeunload = () => (savedEdits < edits || session || finishing || uploads.size ? true : undefined);
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
    setChildren(
      box,
      video,
      video ? answerTranscript(video, transcripts.get(qid), { questionId: qid, pick: (q) => q.answerTranscript, onUpdate: (t) => transcripts.set(qid, t), editable: true }) : null,
      buttons(
        h('button', { class: url ? 'btn btn-small' : 'btn btn-primary btn-small', onclick: action(() => startSession(qid)) }, url ? 'Re-record from here' : '● Answer from here'),
        url ? h('button', { class: 'btn btn-small', onclick: action(() => removeAnswer(qid)) }, 'Remove') : null,
      ),
    );
    resume();
  }

  async function removeAnswer(qid) {
    if (!confirm('Delete this recorded answer?')) return;
    await api('DELETE', `/api/questions/${qid}/video`);
    keepLocal(qid, null);
    videos.set(qid, null);
    transcripts.set(qid, null);
    drawAnswer(qid);
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
        const clip = h('video', { class: 'studio-pip-video', src: url, preload: 'auto', playsinline: true });
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
        h('p', { class: `studio-status${take.answering ? ' is-answering' : ''}` }, take.loading ? 'Loading the question…' : take.answering ? '🎙 Your answer' : '🔊 Playing the question…'),
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
        h('div', {}, h('h2', {}, 'Your answer order'), h('p', { class: 'muted small' }, 'Drag to reorder. Record answers back to back: each question is played to you, you answer, then Save plays the next one. Only questions here with a recorded answer get published, in this order.')),
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
      h('div', { class: 'row gap-sm wrap' }, topicChip(oh), statusBadge(oh)),
      h('h1', {}, oh.title),
      h('p', { class: 'muted small' }, `Answers expected ${fmtDate(oh.answersExpectedAt)} (shown to askers; not enforced) · moderator: ${data.moderator}`),
      h('p', { class: 'notice' }, 'Readers see nothing until you publish. Publishing is final: after that, answers can\'t be re-recorded, removed or reordered.'),
      h(
        'div',
        { class: 'row gap-sm wrap' },
        h('a', { class: 'btn btn-outline', href: `#/oh/${oh.id}` }, 'View public page'),
        oh.status === 'open'
          ? h(
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
            )
          : null,
      ),
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
  const addBtn = h('button', { class: 'btn btn-primary', hidden: true }, 'Add selected to office hours');

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
    h('div', { class: 'row space-between wrap gap-sm' }, h('div', {}, h('h2', {}, '✦ Seed your office hours'), h('p', { class: 'muted small' }, 'The moderator suggests questions from your bio, expertise and topic. Seeds appear as "Suggested by moderator" and can be +1\'d like any question.')), h('button', { class: 'btn btn-outline', onclick: fetchMore }, 'Suggest questions')),
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
    h('div', { class: 'row gap wrap' }, h('label', { class: 'grow' }, 'Questions due by', f.deadline, h('span', { class: 'hint' }, 'Askers can submit and +1 until then.')), h('label', { class: 'grow' }, 'Answers expected', f.answers, h('span', { class: 'hint' }, "Lets people know when to check back. Not enforced."))),
    h('label', { class: 'check' }, f.anon, ' Allow anonymous questions'),
    fromDiscussion,
    me.expertise.length === 0 ? h('p', { class: 'notice' }, 'Tip: ', h('a', { href: `#/u/${me.username}` }, 'add your expertise and bio'), ' so the moderator can suggest better seed questions.') : null,
    h('div', { class: 'row gap-sm' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Announce office hours')),
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
  return h('div', { class: 'narrow' }, h('h1', {}, followUp ? 'Follow-up Q&A' : 'Host office hours'), form);
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
    h('section', {}, h('h2', { class: 'section-title' }, 'Upcoming & open'), upcoming.length ? h('div', { class: 'grid' }, upcoming.map(ohCard)) : empty('No upcoming office hours.', data.isMe ? h('a', { class: 'btn btn-outline', href: '#/oh/new' }, 'Host one') : null)),
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
      ({ user: me } = await api('POST', `/api/auth/${mode}`, { username: f.username.value, password: f.password.value, displayName: f.displayName.value }));
      go(next);
    })({ currentTarget: submit });
  });
  return h('div', { class: 'narrow' }, h('h1', {}, 'Welcome to forum'), h('p', { class: 'muted' }, 'Ask experts questions. Host your own office hours.'), form);
}

// ---------- shell & routing ----------

// Dev-only: switch between users without logging in. Shown when the server runs with --dev.
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
      if (select.value) ({ user: me } = await api('POST', '/api/dev/login', { username: select.value }));
      else {
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
    h('a', { href: '#/', class: 'brand' }, '💬 forum'),
    h('div', { class: 'nav-links' }, me ? link('#/', 'Feed') : null, link('#/explore', 'Explore')),
    h(
      'div',
      { class: 'nav-right' },
      devLogin ? userSwitcher() : null,
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

window.addEventListener('hashchange', render);
({ user: me, devLogin, speech } = await api('GET', '/api/me'));
render();
