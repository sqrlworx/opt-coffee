import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createSession, destroySession, hashPassword, parseCookies, userForSession, verifyPassword } from './auth.js';
import { transaction } from './db.js';
import { cuesFromWords, questionCaptions, saidInAnswer, takeCaptions, toVtt } from './speech/captions.js';
import { createBrollJobs } from './broll/jobs.js';
import { createSpeechJobs } from './speech/jobs.js';
import { SAMPLE_TEXT } from './speech/voices.js';
import { createVideoJobs } from './video.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
// The mobile app's build (mobile/, `npm run build` there), served at /m/.
const MOBILE_DIR = fileURLToPath(new URL('../mobile/dist/', import.meta.url));
const MAX_BODY = 100_000;
const MAX_VIDEO = 300_000_000; // ~10 minutes at the bitrate the browser records with
const MAX_AUDIO = 20_000_000; // a spoken question is capped at 90 seconds in the browser
const MAX_QUESTION_VIDEO = 60_000_000; // so is one asked on camera
const MAX_SPOKEN_QUESTION = 2000; // characters of transcript; people say more than they'd type
const MAX_ANSWER_START = 600; // seconds; a take is capped at 10 minutes in the browser
const MAX_REPLY = 2000; // characters of a reply in a discussion
const MAX_BROLL_PROMPT = 500; // characters describing b-roll
const MAX_BROLL_VIDEO = 500_000_000; // an uploaded b-roll clip: a minute or two of 4K from a phone
const MAX_BROLL_SECONDS = MAX_ANSWER_START; // of it kept, at most: as long as the longest take
const MAX_FILE_NAME = 200; // characters kept of an uploaded file's name
const MAX_SEEDS = 20; // seed questions added at once
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.weba': 'audio/webm', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.vtt': 'text/vtt; charset=utf-8',
};
// What MediaRecorder produces: WebM in Chrome/Firefox, MP4 in Safari (and newer Chrome), Ogg in Firefox.
const VIDEO_TYPES = { 'video/webm': 'webm', 'video/mp4': 'mp4' };
const AUDIO_TYPES = { 'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };
const MEDIA_NAME = /^[0-9a-f]{32}\.(webm|mp4|weba|m4a|ogg)$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const mediaUrl = (name) => (name ? `/media/${name}` : null);
const randomName = (ext) => `${randomBytes(16).toString('hex')}.${ext}`;
const contentType = (req) => String(req.headers['content-type'] ?? '').split(';')[0].trim();

// ---------- validation ----------

function str(value, field, { min = 0, max = 1000, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    if (min > 0) throw new HttpError(400, `${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `${field} must be a string`);
  const v = value.trim();
  if (v.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`);
  if (v.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return v;
}

function isoDate(value, field) {
  const d = new Date(value);
  if (typeof value !== 'string' || Number.isNaN(d.getTime())) throw new HttpError(400, `${field} must be a valid date`);
  return d.toISOString();
}

function parseExpertise(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12).map((t) => t.slice(0, 40));
}

// ---------- serialization ----------

/**
 * Published, but its answers are still being joined into one video. Until then readers see it as
 * closed, so nobody arrives at a page with nothing to watch; only the expert sees it's published.
 */
const processing = (oh) => Boolean(oh.published_at) && oh.video_status === 'pending';

export function statusOf(oh, at = now()) {
  if (oh.published_at) return 'published';
  if (oh.closed_at || oh.questions_deadline <= at) return 'closed';
  return 'open';
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio,
    expertise: u.expertise.split(',').map((t) => t.trim()).filter(Boolean),
  };
}

function isSubscribed(db, viewer, type, id) {
  if (!viewer) return false;
  return Boolean(
    db.prepare('SELECT 1 FROM subscriptions WHERE user_id = ? AND target_type = ? AND target_id = ?').get(viewer.id, type, id),
  );
}

function serializeOfficeHour(db, oh, viewer) {
  const expert = db.prepare('SELECT * FROM users WHERE id = ?').get(oh.expert_id);
  const isExpert = viewer?.id === oh.expert_id;
  const hidden = processing(oh) && !isExpert;
  // Once readers can see it's published, they're only told about the questions that were answered.
  const answeredOnly = !isExpert && !hidden && statusOf(oh) === 'published';
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE office_hour_id = ?${answeredOnly ? ' AND published_position IS NOT NULL' : ''}`).get(oh.id);
  return {
    id: oh.id,
    title: oh.title,
    topic: oh.topic,
    description: oh.description,
    questionsDeadline: oh.questions_deadline,
    answersExpectedAt: oh.answers_expected_at,
    allowAnonymous: Boolean(oh.allow_anonymous),
    createdAt: oh.created_at,
    closedAt: oh.closed_at,
    publishedAt: hidden ? null : oh.published_at,
    status: hidden ? 'closed' : statusOf(oh),
    processing: processing(oh) && isExpert,
    questionCount: n,
    expert: publicUser(expert),
    // A follow-up picks up an earlier office hour's discussion.
    followUpOf: oh.follow_up_of ? db.prepare('SELECT id, title FROM office_hours WHERE id = ?').get(oh.follow_up_of) ?? null : null,
    isExpert,
    subscribed: isSubscribed(db, viewer, 'office_hour', oh.id),
    subscribedToExpert: isSubscribed(db, viewer, 'expert', oh.expert_id),
  };
}

/**
 * The transcript of a recording, if it has one. `captions` is its WebVTT URL once ready; it
 * changes when the text is corrected, so browsers don't keep showing the old subtitles.
 */
function transcriptOf(db, name) {
  const t = name ? db.prepare('SELECT * FROM transcripts WHERE media = ?').get(name) : null;
  if (!t) return null;
  const ready = t.status === 'ready';
  const captions = ready ? `${mediaUrl(name)}.vtt${t.edited_at ? `?v=${Date.parse(t.edited_at)}` : ''}` : null;
  return { status: t.status, text: ready ? t.text : null, cues: ready ? JSON.parse(t.cues) : [], captions, edited: Boolean(t.edited_at) };
}

/**
 * An answer's transcript: only what's said after the question, which plays at the start of the
 * take (up to `answerStart`) and is captioned from the question itself, so it isn't the expert's
 * to correct. Its `captions` still cover the whole take (see captionCues).
 */
function answerTranscriptOf(db, name, answerStart) {
  const t = transcriptOf(db, name);
  if (t?.status !== 'ready' || !answerStart) return t;
  const cues = t.cues.filter(saidInAnswer(answerStart));
  return { ...t, cues, text: cues.map(([, , text]) => text).join(' ') };
}

function loadQuestions(db, ohId, viewer) {
  const rows = db
    .prepare(
      `SELECT q.*, u.username, u.display_name,
              (SELECT COUNT(*) FROM votes v WHERE v.question_id = q.id) AS votes,
              EXISTS (SELECT 1 FROM votes v WHERE v.question_id = q.id AND v.user_id = ?) AS voted
       FROM questions q LEFT JOIN users u ON u.id = q.author_id
       WHERE q.office_hour_id = ?
       ORDER BY q.id`,
    )
    .all(viewer?.id ?? -1, ohId);
  return rows.map((q) => questionView(db, q, viewer));
}

// Seconds as the players show them, m:ss, for messages.
const clock = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;

/**
 * The b-roll the expert asked for in an answer, as only they see it before publishing. `video` once
 * it's made, with `shot`, what was filmed for their description; `start` and `length` place it in
 * the take once it's placed, and stay null if the take is too short for it (or if it's too late
 * in it where they chose); `clipLength` is how long the clip is, so they can be told when not all
 * of it plays. `chosen` is where they chose to cut in to it, seconds into the take, or null when
 * the moderator places it. A clip they uploaded has `upload`, its file's name, and `prompt` only if
 * they said what it shows. `full` is true when it's full screen rather than split screen, which
 * only an uploaded clip can be, and `pastEnd` when, full screen, it plays to its end even past the
 * end of the answer.
 */
function brollOf(q) {
  if (!q.broll_status) return null;
  const ready = q.broll_status === 'ready';
  return {
    prompt: q.broll_prompt,
    upload: q.broll_upload,
    status: q.broll_status,
    shot: ready ? q.broll_shot : null,
    video: ready ? mediaUrl(q.broll_video) : null,
    start: ready ? q.broll_start : null,
    length: ready ? q.broll_length : null,
    clipLength: ready ? q.broll_seconds : null,
    chosen: q.broll_chosen,
    full: Boolean(q.broll_full),
    pastEnd: Boolean(q.broll_past_end),
  };
}

function questionView(db, q, viewer) {
  const audioTranscript = q.asked_with === 'audio' ? transcriptOf(db, q.audio) : null;
  return {
    id: q.id,
    body: q.body,
    source: q.source,
    anonymous: Boolean(q.is_anonymous),
    // Anonymous questions never expose their author, not even to the expert.
    author: q.source === 'asker' && !q.is_anonymous && q.username ? { username: q.username, displayName: q.display_name } : null,
    votes: q.votes,
    voted: Boolean(q.voted),
    mine: viewer != null && q.author_id === viewer.id,
    createdAt: q.created_at,
    // Every question can be read and heard: typed ones are read aloud, spoken ones transcribed.
    askedWith: q.asked_with,
    audio: mediaUrl(q.audio),
    audioStatus: q.audio_status,
    // Asked on camera: the asker's video, or once it's published, its copy that players can seek in.
    // Its sound is `audio`, and the transcript is of that.
    askerVideo: mediaUrl(q.asker_video_copy ?? q.asker_video),
    audioTranscript,
    // How the mouth moves saying `audio`, for the fox that says the question in the joined video.
    lipSync: q.lip_sync ? `/api/questions/${q.id}/lip-sync` : null,
    planPosition: q.plan_position,
    answerVideo: mediaUrl(q.answer_video),
    answerStart: q.answer_start,
    answerTranscript: answerTranscriptOf(db, q.answer_video, q.answer_start),
    publishedPosition: q.published_position,
    publishedAnswerVideo: mediaUrl(q.published_answer_video),
    publishedAnswerStart: q.published_answer_start,
    publishedAnswerTranscript: answerTranscriptOf(db, q.published_answer_video, q.published_answer_start),
    publishedQuestionCues: questionCaptions({ body: q.body, cues: audioTranscript?.cues }, q.published_answer_start).cues,
    broll: brollOf(q),
    publishedBroll: q.published_broll
      ? { video: mediaUrl(q.published_broll), start: q.published_broll_start, length: q.published_broll_length, full: Boolean(q.published_broll_full), pastEnd: Boolean(q.published_broll_past_end) }
      : null,
  };
}

function stripPrivate(q) {
  const { planPosition, answerVideo, answerStart, answerTranscript, publishedPosition, publishedAnswerVideo, publishedAnswerStart, publishedAnswerTranscript, publishedQuestionCues, broll, publishedBroll, ...rest } = q;
  return rest;
}

/**
 * A published answer as readers see it. `answerStart` is where the answer begins, after the
 * question; `questionCues` caption the question until then, timed from the start of the take.
 * `broll` is cut away to during the answer, from `start` for `length` seconds into the take, split
 * screen or, with `full`, full screen; with `pastEnd`, full screen, it may run past the end of the
 * take, which the joined video lengthens for it.
 */
const publishedAnswer = (q) => ({
  ...stripPrivate(q),
  video: q.publishedAnswerVideo,
  answerStart: q.publishedAnswerStart,
  questionCues: q.publishedQuestionCues,
  transcript: q.publishedAnswerTranscript,
  broll: q.publishedBroll,
});

/** What readers see: the snapshot taken at the last publish, in the expert's order. */
function publishedAnswers(questions) {
  return questions
    .filter((q) => q.publishedPosition != null)
    .sort((a, b) => a.publishedPosition - b.publishedPosition)
    .map(publishedAnswer);
}

/**
 * The published answers as one video, or null without ffmpeg. `mobileSrc` is its copy for the mobile
 * app: upright, with full-screen b-roll but not split-screen b-roll (the app plays that in half of
 * its player), and with burned-in captions placed for its split screen (null
 * for a video joined before there were copies; one joined before they were upright is landscape
 * until it's joined again). `chapters` place each answer in it; `captions` is true where its
 * captions are burned into the picture, so players don't draw them again.
 * `questionStart` is how far into the answer its question's sound starts, until found 0.
 * `expertFocus` and `askerFocus` are where the phone's halves crop the expert's picture in its copy
 * and the asker's video to frame their faces, as CSS's object-position (0-1 down); null when the
 * video wasn't finished, or no face was found.
 */
function joinedVideo(oh) {
  if (!oh.video_status) return null;
  const ready = oh.video_status === 'ready';
  const chapters = ready
    ? JSON.parse(oh.video_chapters).map(([questionId, start, end, captioned, questionStart = 0, expertFocus = null, askerFocus = null]) => ({
        questionId,
        start,
        end,
        captions: Boolean(captioned),
        questionStart,
        expertFocus,
        askerFocus,
      }))
    : [];
  return { status: oh.video_status, src: ready ? mediaUrl(oh.video) : null, mobileSrc: ready && oh.video_mobile ? mediaUrl(oh.video_mobile) : null, chapters };
}

/**
 * The discussion under a published answer: replies to it, oldest first, each with the expert's
 * responses to it. `byExpert` marks what the expert wrote.
 */
function discussionOf(db, questionId, expertId, viewer) {
  const rows = db
    .prepare(
      `SELECT r.*, u.username, u.display_name,
              (SELECT COUNT(*) FROM reply_likes l WHERE l.reply_id = r.id) AS likes,
              EXISTS (SELECT 1 FROM reply_likes l WHERE l.reply_id = r.id AND l.user_id = ?) AS liked
       FROM replies r JOIN users u ON u.id = r.author_id
       WHERE r.question_id = ?
       ORDER BY r.id`,
    )
    .all(viewer?.id ?? -1, questionId);
  const view = (r) => ({
    id: r.id,
    body: r.body,
    author: { username: r.username, displayName: r.display_name },
    byExpert: r.author_id === expertId,
    mine: viewer != null && r.author_id === viewer.id,
    likes: r.likes,
    liked: Boolean(r.liked),
    createdAt: r.created_at,
  });
  const replies = rows.filter((r) => r.parent_id == null).map((r) => ({ ...view(r), responses: [] }));
  const byId = new Map(replies.map((r) => [r.id, r]));
  for (const r of rows) if (r.parent_id != null) byId.get(r.parent_id)?.responses.push(view(r));
  return replies;
}

/** The expert's working plan: queued questions that have a recorded answer, as [id, video] pairs. */
function workingAnswers(questions) {
  return questions
    .filter((q) => q.planPosition != null && q.answerVideo)
    .sort((a, b) => a.planPosition - b.planPosition)
    .map((q) => [q.id, q.answerVideo]);
}


// ---------- routes ----------

// `speech` (src/speech/index.js) is optional; without it there are no spoken questions,
// read-aloud audio or transcripts. So is `joiner` (src/video.js); without it published answers
// aren't joined into one video. And `broll` (src/broll/index.js); without it experts can't add
// b-roll to their answers. `mobileDir` is the mobile app's build, served at /m/.
export function createApp({ db, moderator, devLogin = false, mediaDir = 'media', speech = null, joiner = null, broll = null, mobileDir = MOBILE_DIR }) {
  mkdirSync(mediaDir, { recursive: true });
  const speechJobs = speech ? createSpeechJobs({ db, speech, mediaDir }) : null;
  speechJobs?.resume();
  const videoJobs = joiner ? createVideoJobs({ db, joiner, mediaDir }) : null;
  videoJobs?.resume();
  const brollJobs = broll ? createBrollJobs({ db, broll, moderator, mediaDir }) : null;
  brollJobs?.resume();
  const routes = [];
  // `raw` routes get the request body unread (ctx.req) instead of parsed JSON.
  const route = (method, pattern, handler, { auth = false, raw = false } = {}) =>
    routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, auth, raw });

  function getOfficeHour(id) {
    const oh = db.prepare('SELECT * FROM office_hours WHERE id = ?').get(Number(id));
    if (!oh) throw new HttpError(404, 'Off hour not found');
    return oh;
  }

  function requireExpert(oh, user) {
    if (oh.expert_id !== user.id) throw new HttpError(403, 'Only the expert can do that');
  }

  // Publishing is final: after that the answers and their order can't change.
  function requireUnpublished(oh) {
    if (oh.published_at) throw new HttpError(409, 'This off hour is published and can no longer be edited');
  }

  /** A question whose answer the user may record or remove: they're the expert and it isn't published. */
  function editableQuestion(id, user) {
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(id));
    if (!q) throw new HttpError(404, 'Question not found');
    const oh = getOfficeHour(q.office_hour_id);
    requireExpert(oh, user);
    requireUnpublished(oh);
    return q;
  }

  /** Deletes video files, and their transcripts, that no draft or published answer points to any more. */
  function pruneVideos(names) {
    const used = db.prepare('SELECT 1 FROM questions WHERE answer_video = ? OR published_answer_video = ?');
    for (const name of names) {
      if (name && !used.get(name, name)) {
        rmSync(join(mediaDir, name), { force: true });
        db.prepare('DELETE FROM transcripts WHERE media = ?').run(name);
      }
    }
  }

  /**
   * Corrected text for a finished transcript, one line per cue, so every subtitle keeps its
   * timing. An empty line drops that cue. Returns the new text, and `save()` to store it (marked
   * as edited if anything changed). For an answer, `answerStart` limits the lines to the answer:
   * the question before it is kept as it was.
   */
  function correctTranscript(name, lines, { answerStart = null } = {}) {
    const t = name ? db.prepare('SELECT * FROM transcripts WHERE media = ?').get(name) : null;
    if (!t || t.status !== 'ready') throw new HttpError(409, "There's no finished transcript to edit yet");
    const all = JSON.parse(t.cues);
    const inAnswer = saidInAnswer(answerStart);
    const cues = all.filter(inAnswer);
    if (!Array.isArray(lines) || lines.length !== cues.length) throw new HttpError(400, `cues must be an array of ${cues.length} lines`);
    const edited = cues
      .map(([start, end], i) => [start, end, (str(lines[i], `Line ${i + 1}`, { max: 300 }) ?? '').replace(/\s+/g, ' ')])
      .filter(([, , text]) => text);
    if (edited.length === 0) throw new HttpError(400, "The transcript can't be empty");
    const stored = [...all.filter((cue) => !inAnswer(cue)), ...edited];
    const text = edited.map(([, , line]) => line).join(' ');
    const changed = JSON.stringify(stored) !== t.cues;
    return {
      text,
      save: () =>
        changed &&
        db.prepare('UPDATE transcripts SET text = ?, cues = ?, edited_at = ?, updated_at = ? WHERE media = ?').run(stored.map(([, , line]) => line).join(' '), JSON.stringify(stored), now(), now(), name),
    };
  }

  /** Deletes b-roll clips that no draft or published answer points to any more. */
  function pruneBroll(names) {
    const used = db.prepare('SELECT 1 FROM questions WHERE broll_video = ? OR published_broll = ?');
    for (const name of names) if (name && !used.get(name, name)) rmSync(join(mediaDir, name), { force: true });
  }

  /** Deletes a spoken question's recording that was never asked, with its transcript (and video, if it was on camera). */
  function discardRecording(name) {
    const video = db.prepare('SELECT video FROM recordings WHERE media = ?').get(name)?.video;
    for (const file of [name, video]) if (file) rmSync(join(mediaDir, file), { force: true });
    db.prepare('DELETE FROM transcripts WHERE media = ?').run(name);
    db.prepare('DELETE FROM recordings WHERE media = ?').run(name);
  }

  /** Recordings left unasked for a day are abandoned. */
  function pruneRecordings() {
    const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    db.prepare('SELECT media FROM recordings WHERE created_at < ?').all(dayAgo).forEach((r) => discardRecording(r.media));
  }
  pruneRecordings();

  /**
   * Who may fetch a media file: questions' audio and video and published answers (and their b-roll)
   * are public; draft answers and b-roll reach only the expert.
   */
  function canSeeMedia(name, user) {
    if (db.prepare('SELECT 1 FROM questions WHERE audio = ? OR asker_video = ? OR asker_video_copy = ?').get(name, name, name)) return true;
    if (db.prepare('SELECT 1 FROM office_hours WHERE video = ? OR video_mobile = ?').get(name, name)) return true; // only set once published
    const owner = db
      .prepare(
        `SELECT q.published_answer_video, q.published_broll, oh.expert_id FROM questions q JOIN office_hours oh ON oh.id = q.office_hour_id
         WHERE q.answer_video = ? OR q.published_answer_video = ? OR q.broll_video = ? OR q.published_broll = ?`,
      )
      .get(name, name, name, name);
    return Boolean(owner && (owner.published_answer_video === name || owner.published_broll === name || owner.expert_id === user?.id));
  }

  function subscribe(userId, type, id) {
    db.prepare(
      'INSERT OR IGNORE INTO subscriptions (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)',
    ).run(userId, type, id, now());
  }

  /**
   * A published answer people can discuss: its office hour is published and its video is ready
   * (until then readers see it as closed).
   */
  function discussedQuestion(id) {
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(id));
    if (!q) throw new HttpError(404, 'Question not found');
    const oh = getOfficeHour(q.office_hour_id);
    if (!oh.published_at || processing(oh) || q.published_position == null) throw new HttpError(409, 'Only published answers can be discussed');
    return { q, oh };
  }

  function getReply(id) {
    const r = db.prepare('SELECT * FROM replies WHERE id = ?').get(Number(id));
    if (!r) throw new HttpError(404, 'Reply not found');
    return r;
  }

  /** The voice the user's typed questions are read aloud in: the one they last picked, or the default. */
  function voiceOf(user) {
    return speech.voices.some((v) => v.id === user?.voice) ? user.voice : speech.voice;
  }

  // Each voice's preview, kept in the media dir. One wanted before it's made is made (once) while they wait.
  const samples = new Map(); // voice id -> the promise of its file, while it's being made
  async function voiceSample(voice) {
    const file = join(mediaDir, 'voices', `${voice.id}.m4a`);
    if (existsSync(file)) return file;
    if (!samples.has(voice.id)) {
      mkdirSync(dirname(file), { recursive: true });
      const made = speech.speak(SAMPLE_TEXT, file, { voice: voice.id, interactive: true });
      samples.set(voice.id, made.finally(() => samples.delete(voice.id)));
    }
    await samples.get(voice.id);
    return file;
  }
  // Made now, so the first asker to try a voice doesn't wait for it.
  speech?.voices.forEach((v) => voiceSample(v).catch((err) => console.error(`[speech] previewing the voice ${v.id} failed: ${err.message}`)));

  /** Adds seed questions (from the moderator, or a discussion) to an office hour, and reads them aloud. */
  function addSeeds(ohId, texts) {
    const insert = db.prepare("INSERT INTO questions (office_hour_id, author_id, source, body, created_at) VALUES (?, NULL, 'moderator', ?, ?)");
    const ids = texts.map((t) => Number(insert.run(ohId, t, now()).lastInsertRowid));
    return () => ids.forEach((id) => speechJobs?.speak(id));
  }

  function seedTexts(value) {
    if (!Array.isArray(value)) throw new HttpError(400, 'questions must be an array');
    return value.slice(0, MAX_SEEDS).map((q) => str(q, 'Question', { min: 5, max: 500 }));
  }

  /**
   * A published answer with its summary, for the short transcript under the video: the question
   * in a few words and the answer's main points. Only once the answer is transcribed; `pending`
   * while a better (LLM) summary is being written.
   */
  function withSummary(answer) {
    const t = answer.transcript;
    if (t?.status !== 'ready') return { ...answer, summary: null };
    // The take starts with the question being played; the summary is of what comes after.
    const said = t.cues.filter(([start, end]) => (start + end) / 2 >= (answer.answerStart ?? 0)).map(([, , text]) => text);
    return { ...answer, summary: moderator.summarizeAnswer({ question: answer.body, answer: said.join(' ') }) };
  }

  function moderatedView(oh, viewer) {
    const questions = loadQuestions(db, oh.id, viewer);
    const groups = moderator.groupQuestions(questions.map((q) => ({ id: q.id, body: q.body })));
    const order = moderator.suggestOrder(groups, questions);
    return { questions, order };
  }

  // --- auth ---

  route('POST', '/api/auth/register', ({ body, setSession }) => {
    const username = str(body.username, 'Username', { min: 3, max: 30 });
    if (!/^[a-zA-Z0-9_]+$/.test(username)) throw new HttpError(400, 'Username may only contain letters, numbers and _');
    const displayName = str(body.displayName, 'Display name', { max: 60 }) || username;
    const password = str(body.password, 'Password', { min: 8, max: 200 });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'Username is taken');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, displayName, hashPassword(password), now());
    setSession(Number(lastInsertRowid));
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) };
  });

  route('POST', '/api/auth/login', ({ body, setSession }) => {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(body.username ?? '').trim());
    if (!user || !verifyPassword(String(body.password ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Wrong username or password');
    }
    setSession(user.id);
    return { user: publicUser(user) };
  });

  route('POST', '/api/auth/logout', ({ clearSession }) => {
    clearSession();
    return { ok: true };
  });

  // `devSession`: the dev user switcher logged this user in, rather than their password.
  // `voices` read typed questions aloud, each with a `sample` to preview it; `voice` is the viewer's.
  // `broll`: experts can add b-roll to their answers, uploading it, and `makesBroll`: have it made,
  // filmed by `brollModel`.
  route('GET', '/api/me', ({ user }) => ({
    user: user ? publicUser(user) : null,
    devLogin,
    devSession: Boolean(user?.dev_session),
    speech: Boolean(speech),
    broll: Boolean(broll),
    makesBroll: Boolean(broll?.generate),
    brollModel: broll?.generate ? broll.model : null,
    voices: speech ? speech.voices.map((v) => ({ ...v, sample: `/media/voices/${v.id}.m4a` })) : [],
    voice: speech ? voiceOf(user) : null,
  }));

  // Dev-only user switcher: log in as anyone without a password. Off unless explicitly enabled.
  if (devLogin) {
    route('GET', '/api/dev/users', () => ({
      users: db.prepare('SELECT * FROM users ORDER BY username').all().map(({ id, username, display_name }) => ({ id, username, displayName: display_name })),
    }));

    route('POST', '/api/dev/login', ({ body, setSession }) => {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(body.username ?? ''));
      if (!user) throw new HttpError(404, 'User not found');
      setSession(user.id, { dev: true });
      return { user: publicUser(user) };
    });
  }

  route(
    'PATCH',
    '/api/me',
    ({ user, body }) => {
      const displayName = str(body.displayName, 'Display name', { min: 1, max: 60 });
      const bio = str(body.bio, 'Bio', { max: 1000 });
      const expertise = parseExpertise(body.expertise).join(',');
      db.prepare('UPDATE users SET display_name = ?, bio = ?, expertise = ? WHERE id = ?').run(displayName, bio, expertise, user.id);
      return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
    },
    { auth: true },
  );

  // --- people ---

  route('GET', '/api/users/:username', ({ params, user: viewer }) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(params.username);
    if (!u) throw new HttpError(404, 'User not found');
    const officeHours = db
      .prepare('SELECT * FROM office_hours WHERE expert_id = ? ORDER BY created_at DESC')
      .all(u.id)
      .map((oh) => serializeOfficeHour(db, oh, viewer));
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE target_type = 'expert' AND target_id = ?")
      .get(u.id);
    return {
      user: publicUser(u),
      subscriberCount: n,
      subscribed: isSubscribed(db, viewer, 'expert', u.id),
      isMe: viewer?.id === u.id,
      officeHours,
    };
  });

  // --- feed & explore ---

  route(
    'GET',
    '/api/feed',
    ({ user }) => {
      const rows = db
        .prepare(
          `SELECT oh.*,
             (oh.expert_id = :me OR oh.expert_id IN
                (SELECT target_id FROM subscriptions WHERE user_id = :me AND target_type = 'expert')) AS via_expert
           FROM office_hours oh
           WHERE oh.expert_id = :me
              OR oh.expert_id IN (SELECT target_id FROM subscriptions WHERE user_id = :me AND target_type = 'expert')
              OR oh.id IN (SELECT target_id FROM subscriptions WHERE user_id = :me AND target_type = 'office_hour')`,
        )
        .all({ me: user.id });

      const items = [];
      for (const oh of rows) {
        const officeHour = serializeOfficeHour(db, oh, user);
        // "Announced" reaches expert subscribers; people who only follow this office hour
        // found it themselves, so they just get the "published" item.
        if (oh.via_expert) {
          items.push({ type: 'announced', at: oh.created_at, officeHour });
        }
        if (oh.published_at && !processing(oh)) {
          // A teaser, not the Q&A itself: the feed sends people to the office hour page.
          const answers = publishedAnswers(loadQuestions(db, oh.id, user));
          items.push({
            type: 'published',
            at: oh.published_at,
            officeHour,
            answerCount: answers.length,
            preview: answers.slice(0, 3).map((q) => ({ id: q.id, body: q.body })),
          });
        }
      }
      items.sort((a, b) => b.at.localeCompare(a.at));
      return { items: items.slice(0, 100) };
    },
    { auth: true },
  );

  route('GET', '/api/explore', ({ user }) => {
    const t = now();
    const open = db
      .prepare(
        `SELECT * FROM office_hours
         WHERE published_at IS NULL AND closed_at IS NULL AND questions_deadline > ?
         ORDER BY questions_deadline LIMIT 50`,
      )
      .all(t)
      .map((oh) => serializeOfficeHour(db, oh, user));
    const published = db
      .prepare("SELECT * FROM office_hours WHERE published_at IS NOT NULL AND video_status IS NOT 'pending' ORDER BY published_at DESC LIMIT 20")
      .all()
      .map((oh) => serializeOfficeHour(db, oh, user));
    const people = db
      .prepare(
        `SELECT u.*,
           (SELECT COUNT(*) FROM subscriptions s WHERE s.target_type = 'expert' AND s.target_id = u.id) AS subscribers,
           (SELECT COUNT(*) FROM office_hours oh WHERE oh.expert_id = u.id) AS hosted
         FROM users u
         WHERE u.expertise != '' OR EXISTS (SELECT 1 FROM office_hours oh WHERE oh.expert_id = u.id)
         ORDER BY subscribers DESC, hosted DESC, u.id LIMIT 30`,
      )
      .all()
      .map((u) => ({ ...publicUser(u), subscribers: u.subscribers, hosted: u.hosted, subscribed: isSubscribed(db, user, 'expert', u.id) }));
    return { open, published, people };
  });

  // --- office hours ---

  route(
    'POST',
    '/api/office-hours',
    ({ user, body }) => {
      const title = str(body.title, 'Title', { min: 3, max: 120 });
      const topic = str(body.topic, 'Topic', { max: 60, optional: true });
      const description = str(body.description, 'Description', { max: 2000 });
      const deadline = isoDate(body.questionsDeadline, 'Question deadline');
      const answersAt = isoDate(body.answersExpectedAt, 'Answer date');
      if (deadline <= now()) throw new HttpError(400, 'Question deadline must be in the future');
      if (answersAt < deadline) throw new HttpError(400, 'Answer date must be on or after the question deadline');
      // A follow-up picks up the discussion of one of the expert's own published office hours,
      // usually with seed questions taken from it.
      let followUpOf = null;
      if (body.followUpOf != null) {
        const earlier = getOfficeHour(body.followUpOf);
        requireExpert(earlier, user);
        if (!earlier.published_at) throw new HttpError(409, 'Only a published off hour can be followed up');
        followUpOf = earlier.id;
      }
      const seeds = body.questions == null ? [] : seedTexts(body.questions);
      const [id, speak] = transaction(db, () => {
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO office_hours
               (expert_id, title, topic, description, questions_deadline, answers_expected_at, allow_anonymous, created_at, follow_up_of)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(user.id, title, topic, description, deadline, answersAt, body.allowAnonymous ? 1 : 0, now(), followUpOf);
        return [Number(lastInsertRowid), addSeeds(Number(lastInsertRowid), seeds)];
      });
      speak();
      return { officeHour: serializeOfficeHour(db, getOfficeHour(id), user) };
    },
    { auth: true },
  );

  route('GET', '/api/office-hours/:id', ({ params, user }) => {
    const oh = getOfficeHour(params.id);
    const officeHour = serializeOfficeHour(db, oh, user);
    const { questions, order } = moderatedView(oh, user);
    const isExpert = officeHour.isExpert;
    // Once readers can see it's published, the questions that weren't answered are the expert's alone.
    const shown = !isExpert && officeHour.status === 'published' ? questions.filter((q) => q.publishedPosition != null) : questions;
    const visible = isExpert ? shown : shown.map(stripPrivate);
    const byId = new Map(visible.map((q) => [q.id, q]));
    const result = {
      officeHour,
      groups: order.groups
        .map((g) => ({ label: g.label, popularity: g.popularity, questions: g.questionIds.map((id) => byId.get(id)).filter(Boolean) }))
        .filter((g) => g.questions.length),
      answers: officeHour.status === 'published' ? publishedAnswers(questions).map((q) => ({ ...withSummary(q), discussion: discussionOf(db, q.id, oh.expert_id, user) })) : [],
      followUps: db.prepare('SELECT id, title FROM office_hours WHERE follow_up_of = ? ORDER BY created_at').all(oh.id),
      video: officeHour.status === 'published' ? joinedVideo(oh) : null,
      moderator: moderator.name,
    };
    if (isExpert) {
      result.plan = {
        suggestedOrder: order.questionIds,
        queue: questions.filter((q) => q.planPosition != null).sort((a, b) => a.planPosition - b.planPosition).map((q) => q.id),
      };
    }
    return result;
  });

  // Pages poll this while the answers are being joined into one video.
  route('GET', '/api/office-hours/:id/video', ({ params }) => {
    const oh = getOfficeHour(params.id);
    return { video: oh.published_at ? joinedVideo(oh) : null };
  });

  // What the create form starts from for a follow-up: the office hour's details, and questions
  // the moderator took from its discussion.
  route(
    'GET',
    '/api/office-hours/:id/follow-up',
    async ({ params, user }) => {
      const oh = getOfficeHour(params.id);
      requireExpert(oh, user);
      if (!oh.published_at) throw new HttpError(409, 'Only a published off hour can be followed up');
      const discussion = publishedAnswers(loadQuestions(db, oh.id, user)).map((q) => ({
        question: q.body,
        replies: discussionOf(db, q.id, oh.expert_id, user).map((r) => ({
          body: r.body,
          likes: r.likes,
          byExpert: r.byExpert,
          responded: r.responses.some((x) => x.byExpert),
        })),
      }));
      const questions = await moderator.followUpQuestions({ title: oh.title, topic: oh.topic, description: oh.description }, discussion);
      const intro = `A follow-up to "${oh.title}", picking up where its discussion left off.`;
      return {
        followUp: {
          followUpOf: { id: oh.id, title: oh.title },
          title: `Follow-up: ${oh.title}`.slice(0, 120),
          topic: oh.topic,
          description: (oh.description ? `${intro}\n\n${oh.description}` : intro).slice(0, 2000),
          allowAnonymous: Boolean(oh.allow_anonymous),
          questions,
        },
        moderator: moderator.name,
      };
    },
    { auth: true },
  );

  route(
    'POST',
    '/api/office-hours/:id/questions',
    // A typed question has a `body`, and may pick the `voice` it's read aloud in, which becomes the
    // asker's voice for next time. A spoken one, or one asked on camera, names its `recording`
    // (see below) and sends the transcript lines as the asker checked them, in `cues`; that
    // transcript is the question text.
    ({ params, user, body }) => {
      const oh = getOfficeHour(params.id);
      if (statusOf(oh) !== 'open') throw new HttpError(409, 'This off hour is no longer taking questions');
      const anonymous = Boolean(body.anonymous);
      if (anonymous && !oh.allow_anonymous) throw new HttpError(400, 'Anonymous questions are not enabled for this off hour');
      const recording = body.recording == null ? null : String(body.recording);
      let text;
      let fix = null;
      let video = null;
      if (recording) {
        const draft = db.prepare('SELECT video FROM recordings WHERE media = ? AND user_id = ? AND office_hour_id = ?').get(recording, user.id, oh.id);
        if (!draft) throw new HttpError(404, 'That recording has expired. Please record your question again.');
        video = draft.video;
        fix = correctTranscript(recording, body.cues);
        text = fix.text;
        if (text.length < 5) throw new HttpError(400, 'Question must be at least 5 characters');
        if (text.length > MAX_SPOKEN_QUESTION) throw new HttpError(400, 'That question is too long. Please keep it shorter.');
      } else {
        text = str(body.body, 'Question', { min: 5, max: 500 });
      }
      const picked = body.voice == null || !speech || recording ? null : String(body.voice);
      if (picked && !speech.voices.some((v) => v.id === picked)) throw new HttpError(400, 'Unknown voice');
      const voice = speech && !recording ? picked ?? voiceOf(user) : null;
      const id = transaction(db, () => {
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO questions (office_hour_id, author_id, source, is_anonymous, body, asked_with, audio, audio_status, asker_video, voice, created_at)
             VALUES (?, ?, 'asker', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(oh.id, user.id, anonymous ? 1 : 0, text, recording ? 'audio' : 'text', recording, recording ? 'ready' : null, video, voice, now());
        if (picked) db.prepare('UPDATE users SET voice = ? WHERE id = ?').run(picked, user.id);
        if (recording) {
          fix.save();
          db.prepare('DELETE FROM recordings WHERE media = ?').run(recording);
        }
        // Askers want to see the answer, so follow the office hour for them.
        if (oh.expert_id !== user.id) subscribe(user.id, 'office_hour', oh.id);
        return Number(lastInsertRowid);
      });
      // A typed question is read aloud, with its lip sync; a spoken one gets its recording's.
      if (recording) speechJobs?.lipSync(id);
      else speechJobs?.speak(id);
      return { question: stripPrivate(loadQuestions(db, oh.id, user).find((q) => q.id === id)) };
    },
    { auth: true },
  );

  // Asking out loud, step 1: the recording is the raw request body, sound only or on camera. It's
  // transcribed while the asker waits, and comes back as a draft: nothing is asked until the asker
  // has checked (and, if needed, corrected) the transcript and sends it to POST /questions with
  // `recording`. A video's sound is taken out into its own file first; that file is the recording
  // the draft and the question are known by, and the video goes along with it.
  // A recording that can't be transcribed isn't kept.
  route(
    'POST',
    '/api/office-hours/:id/recordings',
    async ({ params, user, req }) => {
      if (!speech) throw new HttpError(503, 'Asking out loud is not available on this server');
      const oh = getOfficeHour(params.id);
      if (statusOf(oh) !== 'open') throw new HttpError(409, 'This off hour is no longer taking questions');
      // Cross-site forms can't send an audio/* or video/* content type, so this also blocks CSRF.
      const videoExt = VIDEO_TYPES[contentType(req)];
      const ext = videoExt ?? AUDIO_TYPES[contentType(req)];
      if (!ext) throw new HttpError(415, 'Expected a WebM, MP4 or Ogg recording');
      pruneRecordings();
      const upload = randomName(ext);
      await saveUpload(req, join(mediaDir, upload), { max: videoExt ? MAX_QUESTION_VIDEO : MAX_AUDIO, label: 'Recording' });
      const video = videoExt ? upload : null;
      const name = videoExt ? randomName('m4a') : upload;
      const file = join(mediaDir, name);
      try {
        if (video) {
          try {
            await speech.extractSound(join(mediaDir, video), file);
          } catch (err) {
            console.error(`[speech] taking the sound out of a question video failed: ${err.message}`);
            throw new HttpError(400, "Couldn't hear anything in that video. Check that your microphone is on, and try again.");
          }
        }
        let heard;
        try {
          heard = await speech.transcribe(file, { interactive: true });
        } catch (err) {
          console.error(`[speech] transcribing a question failed: ${err.message}`);
          throw new HttpError(503, "Couldn't transcribe your recording right now. Please try again.");
        }
        const text = heard.text.trim();
        if (text.length < 5) throw new HttpError(400, "Couldn't make out a question in that recording. Try again, a little closer to the mic.");
        if (text.length > MAX_SPOKEN_QUESTION) throw new HttpError(400, 'That question is too long. Please keep it shorter.');
        const cues = cuesFromWords(heard.words);
        transaction(db, () => {
          db.prepare("INSERT INTO transcripts (media, status, text, cues, words, updated_at) VALUES (?, 'ready', ?, ?, ?, ?)").run(name, text, JSON.stringify(cues), JSON.stringify(heard.words), now());
          db.prepare('INSERT INTO recordings (media, video, user_id, office_hour_id, created_at) VALUES (?, ?, ?, ?, ?)').run(name, video, user.id, oh.id, now());
        });
        return { recording: { id: name, text, cues } };
      } catch (err) {
        for (const f of [upload, name]) rmSync(join(mediaDir, f), { force: true });
        throw err;
      }
    },
    { auth: true, raw: true },
  );

  // The asker re-recorded or gave up on a recording they hadn't asked yet.
  route(
    'DELETE',
    '/api/recordings/:id',
    ({ params, user }) => {
      if (db.prepare('SELECT 1 FROM recordings WHERE media = ? AND user_id = ?').get(params.id, user.id)) discardRecording(params.id);
      return { ok: true };
    },
    { auth: true },
  );

  // The expert can correct an answer's transcript, even after publishing: publishing locks the
  // answer, not typos in its transcript (which may only have finished after publishing).
  route(
    'PUT',
    '/api/questions/:id/answer-transcript',
    ({ params, user, body }) => {
      const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(params.id));
      if (!q) throw new HttpError(404, 'Question not found');
      const oh = getOfficeHour(q.office_hour_id);
      requireExpert(oh, user);
      const [name, answerStart] = oh.published_at ? [q.published_answer_video, q.published_answer_start] : [q.answer_video, q.answer_start];
      // Captions burned into the joined video are remade from the corrected transcript.
      if (correctTranscript(name, body.cues, { answerStart }).save() && oh.published_at) videoJobs?.refresh(oh.id);
      return { transcript: answerTranscriptOf(db, name, answerStart) };
    },
    { auth: true },
  );

  // One question as the viewer may see it. Pages poll this while its speech is being processed.
  route('GET', '/api/questions/:id', ({ params, user }) => {
    const row = db.prepare('SELECT office_hour_id FROM questions WHERE id = ?').get(Number(params.id));
    if (!row) throw new HttpError(404, 'Question not found');
    const oh = getOfficeHour(row.office_hour_id);
    const q = loadQuestions(db, oh.id, user).find((x) => x.id === Number(params.id));
    if (oh.published_at && q.publishedPosition != null && (!processing(oh) || oh.expert_id === user?.id)) return { question: withSummary(publishedAnswer(q)) };
    return { question: oh.expert_id === user?.id ? q : stripPrivate(q) };
  });

  // A question's lip sync (its `lipSync`), which is as public as its audio.
  route('GET', '/api/questions/:id/lip-sync', ({ params }) => {
    const q = db.prepare('SELECT lip_sync FROM questions WHERE id = ?').get(Number(params.id));
    if (!q?.lip_sync) throw new HttpError(404, 'This question has no lip sync');
    return { lipSync: JSON.parse(q.lip_sync) };
  });

  function setVote(params, user, on) {
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(Number(params.id));
    if (!q) throw new HttpError(404, 'Question not found');
    if (statusOf(getOfficeHour(q.office_hour_id)) !== 'open') throw new HttpError(409, 'Voting has closed');
    if (on) {
      db.prepare('INSERT OR IGNORE INTO votes (question_id, user_id, created_at) VALUES (?, ?, ?)').run(q.id, user.id, now());
    } else {
      db.prepare('DELETE FROM votes WHERE question_id = ? AND user_id = ?').run(q.id, user.id);
    }
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE question_id = ?').get(q.id);
    return { votes: n, voted: on };
  }

  route('POST', '/api/questions/:id/vote', ({ params, user }) => setVote(params, user, true), { auth: true });
  route('DELETE', '/api/questions/:id/vote', ({ params, user }) => setVote(params, user, false), { auth: true });

  // A reply to a published answer. With `parentId`, the expert responding to one of those replies:
  // that's as deep as a discussion goes.
  route(
    'POST',
    '/api/questions/:id/replies',
    ({ params, user, body }) => {
      const { q, oh } = discussedQuestion(params.id);
      const text = str(body.body, 'Reply', { min: 1, max: MAX_REPLY });
      let parentId = null;
      if (body.parentId != null) {
        const parent = getReply(body.parentId);
        if (parent.question_id !== q.id) throw new HttpError(400, 'That reply is about a different answer');
        if (parent.parent_id != null) throw new HttpError(400, 'Responses can only be to a reply to the answer');
        if (oh.expert_id !== user.id) throw new HttpError(403, 'Only the expert can respond to a reply');
        parentId = parent.id;
      }
      const { lastInsertRowid } = db
        .prepare('INSERT INTO replies (question_id, parent_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(q.id, parentId, user.id, text, now());
      const id = Number(lastInsertRowid);
      const all = discussionOf(db, q.id, oh.expert_id, user);
      const reply = parentId ? all.find((r) => r.id === parentId).responses.find((r) => r.id === id) : all.find((r) => r.id === id);
      return { reply };
    },
    { auth: true },
  );

  function setLike(params, user, on) {
    const r = getReply(params.id);
    discussedQuestion(r.question_id);
    if (r.author_id === user.id) throw new HttpError(400, "You can't like your own reply");
    if (on) db.prepare('INSERT OR IGNORE INTO reply_likes (reply_id, user_id, created_at) VALUES (?, ?, ?)').run(r.id, user.id, now());
    else db.prepare('DELETE FROM reply_likes WHERE reply_id = ? AND user_id = ?').run(r.id, user.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM reply_likes WHERE reply_id = ?').get(r.id);
    return { likes: n, liked: on };
  }

  route('POST', '/api/replies/:id/like', ({ params, user }) => setLike(params, user, true), { auth: true });
  route('DELETE', '/api/replies/:id/like', ({ params, user }) => setLike(params, user, false), { auth: true });

  route(
    'POST',
    '/api/office-hours/:id/suggestions',
    async ({ params, user, body }) => {
      const oh = getOfficeHour(params.id);
      requireExpert(oh, user);
      const existing = db.prepare('SELECT body FROM questions WHERE office_hour_id = ?').all(oh.id).map((r) => r.body);
      const exclude = Array.isArray(body.exclude) ? body.exclude.filter((s) => typeof s === 'string').slice(0, 50) : [];
      const questions = await moderator.suggestQuestions(
        publicUser(user),
        { title: oh.title, topic: oh.topic, description: oh.description },
        { existing: existing.concat(exclude), round: Number(body.round) || 0 },
      );
      return { questions, moderator: moderator.name };
    },
    { auth: true },
  );

  route(
    'POST',
    '/api/office-hours/:id/seed',
    ({ params, user, body }) => {
      const oh = getOfficeHour(params.id);
      requireExpert(oh, user);
      if (statusOf(oh) !== 'open') throw new HttpError(409, 'Seed questions can only be added while questions are open');
      const texts = seedTexts(body.questions);
      if (texts.length === 0) throw new HttpError(400, 'questions must be a non-empty array');
      transaction(db, () => addSeeds(oh.id, texts))();
      return { added: texts.length };
    },
    { auth: true },
  );

  route(
    'PUT',
    '/api/office-hours/:id/plan',
    ({ params, user, body }) => {
      const oh = getOfficeHour(params.id);
      requireExpert(oh, user);
      requireUnpublished(oh);
      if (!Array.isArray(body.items)) throw new HttpError(400, 'items must be an array');
      const valid = new Set(db.prepare('SELECT id FROM questions WHERE office_hour_id = ?').all(oh.id).map((r) => r.id));
      const seen = new Set();
      const items = body.items.map((item) => {
        const id = Number(item?.questionId);
        if (!valid.has(id)) throw new HttpError(400, `Question ${item?.questionId} is not part of this off hour`);
        if (seen.has(id)) throw new HttpError(400, `Question ${id} appears twice`);
        seen.add(id);
        return id;
      });
      transaction(db, () => {
        // Un-queued questions keep any recorded answer so removing one doesn't lose work.
        db.prepare('UPDATE questions SET plan_position = NULL WHERE office_hour_id = ?').run(oh.id);
        const update = db.prepare('UPDATE questions SET plan_position = ? WHERE id = ?');
        items.forEach((id, i) => update.run(i + 1, id));
      });
      return { ok: true };
    },
    { auth: true },
  );

  // The expert records answers in the browser; each take is sent here as the raw video body.
  // A take recorded in a session starts with the question being played; `?answerStart=<seconds>`
  // says where the answer begins. Readers don't see it until the expert publishes.
  route(
    'PUT',
    '/api/questions/:id/video',
    async ({ params, user, req, url }) => {
      const q = editableQuestion(params.id, user);
      const answerStart = url.searchParams.has('answerStart') ? Number(url.searchParams.get('answerStart')) : null;
      if (answerStart != null && !(answerStart >= 0 && answerStart <= MAX_ANSWER_START)) throw new HttpError(400, `answerStart must be between 0 and ${MAX_ANSWER_START} seconds`);
      // Cross-site forms can't send a video/* content type, so this also blocks CSRF.
      const ext = VIDEO_TYPES[contentType(req)];
      if (!ext) throw new HttpError(415, 'Expected a WebM or MP4 video');
      const name = randomName(ext);
      await saveUpload(req, join(mediaDir, name), { max: MAX_VIDEO, label: 'Video' });
      // The office hour may have been published while the video was uploading.
      const current = db.prepare('SELECT answer_video, broll_status FROM questions WHERE id = ?').get(q.id);
      try {
        requireUnpublished(getOfficeHour(q.office_hour_id));
      } catch (err) {
        pruneVideos([name]);
        throw err;
      }
      // Where the expert chose to cut in to b-roll was a moment in the old take.
      db.prepare('UPDATE questions SET answer_video = ?, answer_start = ?, broll_chosen = NULL WHERE id = ?').run(name, answerStart, q.id);
      pruneVideos([current.answer_video]);
      speechJobs?.transcribe(name);
      // B-roll moves to where it fits in the new take. One still being made or placed goes in it anyway.
      if (current.broll_status === 'ready') brollJobs?.place(q.id);
      const broll = brollOf(db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id));
      return { video: mediaUrl(name), transcript: answerTranscriptOf(db, name, answerStart), broll };
    },
    { auth: true, raw: true },
  );

  route(
    'DELETE',
    '/api/questions/:id/video',
    ({ params, user }) => {
      const q = editableQuestion(params.id, user);
      // Its b-roll is kept, unplaced, for the next take.
      db.prepare('UPDATE questions SET answer_video = NULL, answer_start = NULL, broll_start = NULL, broll_length = NULL, broll_chosen = NULL WHERE id = ?').run(q.id);
      pruneVideos([q.answer_video]);
      return { video: null, broll: brollOf(db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id)) };
    },
    { auth: true },
  );

  /** How much b-roll a question's answer has room for (see brollJobs.room), for a clip `clip` seconds long; refused if none. */
  async function brollRoom(q, clip) {
    if (!q.answer_video) throw new HttpError(409, 'Record an answer before adding b-roll to it');
    let room;
    try {
      room = await brollJobs.room(q.answer_video, q.answer_start, clip);
    } catch (err) {
      console.error(`[broll] measuring the answer to question ${q.id} failed: ${err.message}`);
      throw new HttpError(500, "Couldn't read this answer's video");
    }
    if (!room) throw new HttpError(400, 'This answer is too short for b-roll');
    return room;
  }

  // B-roll for an answer: the expert describes a shot to cut away to while they talk. A clip of it
  // is made in the background, as long as the answer has room for, and placed in the take where
  // it fits what's being said (src/broll/jobs.js). Asking again replaces it.
  route(
    'POST',
    '/api/questions/:id/broll',
    async ({ params, user, body }) => {
      if (!brollJobs) throw new HttpError(503, 'B-roll is not available on this server');
      if (!broll.generate) throw new HttpError(503, "B-roll can't be made on this server, only uploaded");
      const q = editableQuestion(params.id, user);
      const prompt = str(body.prompt, 'Description', { min: 3, max: MAX_BROLL_PROMPT }).replace(/\s+/g, ' ');
      await brollRoom(q);
      // The office hour may have been published meanwhile.
      const current = editableQuestion(params.id, user);
      db.prepare(
        `UPDATE questions SET broll_prompt = ?, broll_upload = NULL, broll_status = 'pending', broll_shot = NULL, broll_video = ?, broll_start = NULL, broll_length = NULL,
         broll_full = 0, broll_past_end = 0, broll_chosen = NULL, broll_seconds = NULL WHERE id = ?`,
      ).run(prompt, randomName('mp4'), q.id);
      pruneBroll([current.broll_video]);
      brollJobs.cancel(q.id);
      brollJobs.generate(q.id);
      return { broll: brollOf(db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id)) };
    },
    { auth: true },
  );

  // Or the expert uploads a clip of their own, as the raw body: any video ffmpeg reads (a phone's
  // MOV, say), with `?name=`, its file's name, `?description=`, what it shows, if they say, and
  // `?full=1` for full screen rather than split screen. It's made into a clip like the ones that are
  // made, of all of it up to the longest a take can be (src/broll/index.js), then placed the same
  // way, right away; where it's placed decides how much of it plays. It replaces any b-roll before it.
  route(
    'PUT',
    '/api/questions/:id/broll/video',
    async ({ params, user, req, url }) => {
      if (!brollJobs) throw new HttpError(503, 'B-roll is not available on this server');
      const q = editableQuestion(params.id, user);
      const description = str(url.searchParams.get('description'), 'Description', { max: MAX_BROLL_PROMPT, optional: true })?.replace(/\s+/g, ' ') || null;
      const name = Array.from(String(url.searchParams.get('name') ?? '').replace(/[\p{C}\s]+/gu, ' ').trim()).slice(0, MAX_FILE_NAME).join('') || 'video';
      const full = url.searchParams.get('full') === '1';
      // Cross-site forms can't send these content types, so this also blocks CSRF. What the file
      // really is, ffmpeg finds out.
      const type = contentType(req);
      if (!type.startsWith('video/') && type !== 'application/octet-stream') throw new HttpError(415, 'Expected a video');
      await brollRoom(q, Infinity);
      const upload = join(mediaDir, randomName('upload'));
      const clip = randomName('mp4');
      let made;
      let current;
      try {
        await saveUpload(req, upload, { max: MAX_BROLL_VIDEO, label: 'Video' });
        made = await broll.prepare(upload, join(mediaDir, clip), { seconds: MAX_BROLL_SECONDS }).catch((err) => {
          console.error(`[broll] getting the clip uploaded for question ${q.id} ready failed: ${err.message}`);
          throw new HttpError(415, "That file couldn't be read as a video. Try an MP4, MOV or WebM.");
        });
        // The answer may have been recorded again while it was uploading, or the office hour published.
        const latest = editableQuestion(params.id, user);
        if (latest.answer_video && !(await brollJobs.room(latest.answer_video, latest.answer_start, made.seconds))) throw new HttpError(400, 'This clip is too short for b-roll');
        current = editableQuestion(params.id, user); // and as it is now, after measuring
      } catch (err) {
        await rm(join(mediaDir, clip), { force: true });
        throw err;
      } finally {
        await rm(upload, { force: true });
      }
      db.prepare(
        `UPDATE questions SET broll_prompt = ?, broll_upload = ?, broll_status = 'pending', broll_shot = NULL, broll_video = ?, broll_start = NULL, broll_length = NULL,
         broll_full = ?, broll_past_end = 0, broll_chosen = NULL, broll_seconds = NULL WHERE id = ?`,
      ).run(description, name, clip, full ? 1 : 0, q.id);
      pruneBroll([current.broll_video]);
      brollJobs.cancel(q.id);
      brollJobs.place(q.id);
      // Only the start of a clip longer than a take can be is kept, which is worth saying.
      const trimmed = made.original > made.seconds + 0.5 ? { from: made.original, to: made.seconds } : null;
      return { broll: brollOf(db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id)), trimmed };
    },
    { auth: true, raw: true },
  );

  // How b-roll plays, changed without making or uploading it again: a clip the expert uploaded goes
  // full screen with `full: true`, or back to split screen, and full screen, `pastEnd: true` lets it
  // play to its end even past the end of the answer, which gets longer. `start` cuts it in there,
  // seconds into the take, rather than where the moderator places it, which `start: null` goes back
  // to. It's placed again, since where it fits depends on all of these. Where the expert chose is
  // placed at once, so it comes back placed; the moderator may take a few seconds, so that doesn't.
  route(
    'PATCH',
    '/api/questions/:id/broll',
    async ({ params, user, body }) => {
      if (!brollJobs) throw new HttpError(503, 'B-roll is not available on this server');
      const q = editableQuestion(params.id, user);
      if (!q.broll_status) throw new HttpError(404, 'This answer has no b-roll');
      const has = (key) => body[key] !== undefined;
      if (!['full', 'pastEnd', 'start'].some(has)) throw new HttpError(400, 'Say full, pastEnd or start');
      for (const key of ['full', 'pastEnd']) if (has(key) && typeof body[key] !== 'boolean') throw new HttpError(400, `Say ${key}: true or false`);
      if ((body.full || body.pastEnd) && !q.broll_upload) throw new HttpError(400, 'Only a video you upload can be full screen');
      if (has('start') && body.start !== null && !Number.isFinite(body.start)) throw new HttpError(400, 'Say start: seconds into your answer, or null');
      const full = has('full') ? body.full : Boolean(q.broll_full);
      const pastEnd = has('pastEnd') ? body.pastEnd : Boolean(q.broll_past_end);
      const start = has('start') ? body.start && Math.round(body.start * 1000) / 1000 : q.broll_chosen;
      if (has('start') && start != null) await checkCut(q, start, { full, pastEnd: full && pastEnd });
      const latest = editableQuestion(params.id, user); // the office hour may have been published meanwhile
      if (Boolean(latest.broll_full) !== full || Boolean(latest.broll_past_end) !== pastEnd || latest.broll_chosen !== start) {
        db.prepare('UPDATE questions SET broll_full = ?, broll_past_end = ?, broll_chosen = ? WHERE id = ?').run(full ? 1 : 0, pastEnd ? 1 : 0, start, q.id);
        const placing = brollJobs.place(q.id);
        if (start != null) await placing;
      }
      return { broll: brollOf(db.prepare('SELECT * FROM questions WHERE id = ?').get(q.id)) };
    },
    { auth: true },
  );

  // Refuses cutting in to a question's b-roll at `start`, seconds into its take, where it can't go:
  // before the answer starts, or too near its end for any of it to play (see placeBroll).
  async function checkCut(q, start, { full, pastEnd }) {
    if (q.broll_status !== 'ready') throw new HttpError(409, 'Wait for your b-roll to be ready before choosing where it goes');
    if (!q.answer_video) throw new HttpError(409, 'Record an answer before choosing where its b-roll goes');
    const answerStart = q.answer_start ?? 0;
    // A moment before it, as the players show it, is close enough.
    if (start < answerStart - 1) throw new HttpError(400, `That's still the question. Cut in after your answer starts, at ${clock(Math.ceil(answerStart))}.`);
    let end;
    let clip;
    try {
      [end, clip] = await Promise.all([broll.duration(join(mediaDir, q.answer_video)), broll.duration(join(mediaDir, q.broll_video))]);
    } catch (err) {
      console.error(`[broll] measuring the answer to question ${q.id} or its b-roll failed: ${err.message}`);
      throw new HttpError(500, "Couldn't read this answer's video");
    }
    const placed = await moderator.placeBroll({ description: '', question: '', clip, answerStart, end, cues: null, words: null, full, pastEnd, start });
    if (!placed) {
      const instead = full && !pastEnd ? ', or let it keep playing past the end of your answer' : '';
      throw new HttpError(400, `There's too little of your answer left after ${clock(start)} for b-roll. Cut in earlier${instead}.`);
    }
  }

  route(
    'DELETE',
    '/api/questions/:id/broll',
    ({ params, user }) => {
      const q = editableQuestion(params.id, user);
      db.prepare(
        `UPDATE questions SET broll_prompt = NULL, broll_upload = NULL, broll_status = NULL, broll_shot = NULL, broll_video = NULL, broll_start = NULL, broll_length = NULL,
         broll_full = 0, broll_past_end = 0, broll_chosen = NULL, broll_seconds = NULL WHERE id = ?`,
      ).run(q.id);
      pruneBroll([q.broll_video]);
      brollJobs?.cancel(q.id);
      return { broll: null };
    },
    { auth: true },
  );

  route(
    'POST',
    '/api/office-hours/:id/close',
    ({ params, user }) => {
      const oh = getOfficeHour(params.id);
      requireExpert(oh, user);
      if (statusOf(oh) === 'open') db.prepare('UPDATE office_hours SET closed_at = ? WHERE id = ?').run(now(), oh.id);
      return { officeHour: serializeOfficeHour(db, getOfficeHour(oh.id), user) };
    },
    { auth: true },
  );

  route(
    'POST',
    '/api/office-hours/:id/publish',
    ({ params, user }) => {
      // Publishes the expert's working plan, once. After this nothing about the answers can change.
      const oh = getOfficeHour(params.id);
      requireExpert(oh, user);
      requireUnpublished(oh);
      const questions = loadQuestions(db, oh.id, user);
      const working = workingAnswers(questions);
      if (working.length === 0) throw new HttpError(400, 'Record an answer for at least one queued question before publishing');
      const making = questions.find((q) => working.some(([id]) => id === q.id) && q.broll?.status === 'pending');
      if (making) throw new HttpError(409, `The b-roll for question ${making.planPosition} is still being made. Wait for it, or remove it, before publishing.`);
      const t = now();
      const [unused, unusedBroll] = transaction(db, () => {
        // B-roll goes with an answer if it's made and placed.
        const placed = "broll_status = 'ready' AND broll_start IS NOT NULL";
        const snapshot = db.prepare(
          `UPDATE questions SET published_position = ?, published_answer_video = answer_video, published_answer_start = answer_start,
             published_broll = IIF(${placed}, broll_video, NULL), published_broll_start = IIF(${placed}, broll_start, NULL), published_broll_length = IIF(${placed}, broll_length, NULL),
             published_broll_full = IIF(${placed}, broll_full, NULL), published_broll_past_end = IIF(${placed}, broll_full AND broll_past_end, NULL)
           WHERE id = ?`,
        );
        working.forEach(([id], i) => snapshot.run(i + 1, id));
        db.prepare('UPDATE office_hours SET published_at = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?').run(t, t, oh.id);
        // Videos recorded for questions that didn't make the cut can never be published now.
        const leftover = 'FROM questions WHERE office_hour_id = ? AND published_position IS NULL AND answer_video IS NOT NULL';
        const names = db.prepare(`SELECT answer_video ${leftover}`).all(oh.id).map((r) => r.answer_video);
        db.prepare(`UPDATE questions SET answer_video = NULL, answer_start = NULL WHERE id IN (SELECT id ${leftover})`).run(oh.id);
        // Nor can b-roll that wasn't published with an answer.
        const leftoverBroll = 'FROM questions WHERE office_hour_id = ? AND broll_video IS NOT NULL AND published_broll IS NOT broll_video';
        const clips = db.prepare(`SELECT broll_video ${leftoverBroll}`).all(oh.id).map((r) => r.broll_video);
        db.prepare(`UPDATE questions SET broll_prompt = NULL, broll_upload = NULL, broll_status = NULL, broll_shot = NULL, broll_video = NULL, broll_start = NULL, broll_length = NULL, broll_full = 0 WHERE id IN (SELECT id ${leftoverBroll})`).run(oh.id);
        return [names, clips];
      });
      pruneVideos(unused);
      pruneBroll(unusedBroll);
      videoJobs?.join(oh.id);
      return { officeHour: serializeOfficeHour(db, getOfficeHour(oh.id), user) };
    },
    { auth: true },
  );

  // --- subscriptions ---

  function subscriptionTarget(body, user) {
    const type = body.type;
    const id = Number(body.id);
    if (type === 'expert') {
      if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'User not found');
      if (id === user.id) throw new HttpError(400, "You can't subscribe to yourself");
    } else if (type === 'office_hour') {
      getOfficeHour(id);
    } else {
      throw new HttpError(400, "type must be 'expert' or 'office_hour'");
    }
    return { type, id };
  }

  route(
    'POST',
    '/api/subscriptions',
    ({ user, body }) => {
      const { type, id } = subscriptionTarget(body, user);
      subscribe(user.id, type, id);
      return { subscribed: true };
    },
    { auth: true },
  );

  route(
    'DELETE',
    '/api/subscriptions',
    ({ user, body }) => {
      const { type, id } = subscriptionTarget(body, user);
      db.prepare('DELETE FROM subscriptions WHERE user_id = ? AND target_type = ? AND target_id = ?').run(user.id, type, id);
      return { subscribed: false };
    },
    { auth: true },
  );

  // ---------- request handling ----------

  async function readJson(req) {
    if (req.method === 'GET' || req.method === 'HEAD') return {};
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
    if (size === 0) return {};
    // Requiring JSON blocks cross-site form posts (they can't set this header without CORS).
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      throw new HttpError(415, 'Expected application/json');
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  async function saveUpload(req, file, { max, label }) {
    if (Number(req.headers['content-length']) > max) throw new HttpError(413, `${label} is too large`);
    const part = `${file}.part`;
    let size = 0;
    try {
      await pipeline(
        req,
        async function* limit(source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > max) throw new HttpError(413, `${label} is too large`);
            yield chunk;
          }
        },
        createWriteStream(part),
      );
      if (size === 0) throw new HttpError(400, 'The recording is empty');
      await rename(part, file);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
  }

  // A recording's subtitles, once it's transcribed: its transcript, except that an answer's begin
  // with the question as it was asked (see takeCaptions).
  function captionCues(name) {
    const t = db.prepare("SELECT cues FROM transcripts WHERE media = ? AND status = 'ready'").get(name);
    if (!t) return null;
    const cues = JSON.parse(t.cues);
    const q = db.prepare('SELECT * FROM questions WHERE answer_video = ? OR published_answer_video = ?').get(name, name);
    if (!q) return cues;
    const asked = q.asked_with === 'audio' ? db.prepare("SELECT cues FROM transcripts WHERE media = ? AND status = 'ready'").get(q.audio) : null;
    return takeCaptions({ body: q.body, cues: asked && JSON.parse(asked.cues) }, { cues }, q.answer_video === name ? q.answer_start : q.published_answer_start).cues;
  }

  // Recordings, plus `<name>.vtt` captions for any that are transcribed. See canSeeMedia for
  // who gets what. Also `voices/<id>.m4a`, each voice's public preview. Supports Range requests,
  // which browsers need to seek (and Safari needs to play at all).
  async function serveMedia(req, res, pathname, user) {
    const path = pathname.slice('/media/'.length);
    const voice = speech?.voices.find((v) => path === `voices/${v.id}.m4a`);
    let file;
    if (voice) {
      try {
        file = await voiceSample(voice);
      } catch (err) {
        console.error(`[speech] previewing the voice ${voice.id} failed: ${err.message}`);
        return sendJson(res, 503, { error: "Couldn't prepare that voice right now" });
      }
    } else {
      const captions = path.endsWith('.vtt');
      const name = captions ? path.slice(0, -'.vtt'.length) : path;
      if (!MEDIA_NAME.test(name) || !canSeeMedia(name, user)) return sendJson(res, 404, { error: 'Not found' });
      if (captions) {
        const cues = captionCues(name);
        if (!cues) return sendJson(res, 404, { error: 'Not found' });
        const vtt = Buffer.from(toVtt(cues));
        res.writeHead(200, { 'Content-Type': MIME['.vtt'], 'Content-Length': vtt.length, 'Cache-Control': 'private, no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : vtt);
      }
      file = join(mediaDir, name);
    }
    const { size } = await stat(file);
    let start = 0;
    let end = size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(range[2])); // suffix range: the last N bytes
      }
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
    }
    const partial = start !== 0 || end !== size - 1;
    res.writeHead(partial ? 206 : 200, {
      'Content-Type': MIME[extname(file)],
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).pipe(res);
  }

  async function serveStatic(req, res, pathname, dir = PUBLIC_DIR) {
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    } catch {
      return sendJson(res, 400, { error: 'Bad request' }); // a malformed %-escape names no file
    }
    const file = normalize(join(dir, rel));
    try {
      if (!file.startsWith(dir) || rel.split(/[\\/]/).includes('..')) throw new Error('outside public dir');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      // Unknown paths get the SPA shell; routing happens client-side via the hash.
      const data = await readFile(join(dir, 'index.html'));
      res.writeHead(pathname.includes('.') && !pathname.endsWith('.html') ? 404 : 200, { 'Content-Type': MIME['.html'] });
      res.end(data);
    }
  }

  // The mobile app, at /m/ once it's built. It's another shell over the same API and media.
  async function serveMobile(req, res, pathname) {
    if (pathname === '/m') {
      res.writeHead(301, { Location: '/m/' });
      return res.end();
    }
    const dir = normalize(join(mobileDir, '/'));
    if (!existsSync(join(dir, 'index.html'))) return sendJson(res, 404, { error: "The mobile app isn't built. Run: cd mobile && npm install && npm run build" });
    return serveStatic(req, res, pathname.slice('/m'.length), dir);
  }

  function sendJson(res, status, payload, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(payload));
  }

  // `idle()` resolves when background speech, video and b-roll work is done (for tests).
  return Object.assign(handle, { idle: () => Promise.all([speechJobs?.idle(), videoJobs?.idle(), brollJobs?.idle()]) });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      if (url.pathname.startsWith('/media/')) {
        return serveMedia(req, res, url.pathname, userForSession(db, parseCookies(req.headers.cookie).sid)).catch((err) => {
          console.error(err);
          if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong' });
          else res.destroy();
        });
      }
      if (url.pathname === '/m' || url.pathname.startsWith('/m/')) return serveMobile(req, res, url.pathname);
      return serveStatic(req, res, url.pathname);
    }

    const headers = {};
    try {
      const match = routes
        .map((r) => ({ r, m: req.method === r.method && url.pathname.match(r.pattern) }))
        .find(({ m }) => m);
      if (!match) throw new HttpError(404, 'Not found');

      const cookies = parseCookies(req.headers.cookie);
      const user = userForSession(db, cookies.sid);
      if (match.r.auth && !user) throw new HttpError(401, 'Please log in');

      const body = match.r.raw ? {} : await readJson(req);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      const ctx = {
        req,
        url,
        user,
        body,
        params: match.m.groups ?? {},
        setSession(userId, options) {
          const { token, maxAge } = createSession(db, userId, options);
          headers['Set-Cookie'] = `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
        },
        clearSession() {
          destroySession(db, cookies.sid);
          headers['Set-Cookie'] = `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
        },
      };
      const result = await match.r.handler(ctx);
      sendJson(res, 200, result, headers);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message }, headers);
      console.error(err);
      sendJson(res, 500, { error: 'Something went wrong' }, headers);
    }
  }
}
