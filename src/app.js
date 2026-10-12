import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createSession, destroySession, hashPassword, parseCookies, userForSession, verifyPassword } from './auth.js';
import { transaction } from './db.js';
import { cuesFromWords, questionCaptions, saidInAnswer, takeCaptions, toVtt } from './speech/captions.js';
import { createSpeechJobs } from './speech/jobs.js';
import { createVideoJobs } from './video.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 100_000;
const MAX_VIDEO = 300_000_000; // ~10 minutes at the bitrate the browser records with
const MAX_AUDIO = 20_000_000; // a spoken question is capped at 90 seconds in the browser
const MAX_QUESTION_VIDEO = 60_000_000; // so is one asked on camera
const MAX_SPOKEN_QUESTION = 2000; // characters of transcript; people say more than they'd type
const MAX_ANSWER_START = 600; // seconds; a take is capped at 10 minutes in the browser
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp',
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
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM questions WHERE office_hour_id = ?').get(oh.id);
  const isExpert = viewer?.id === oh.expert_id;
  const hidden = processing(oh) && !isExpert;
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
    // Asked on camera: the asker's video. Its sound is `audio`, and the transcript is of that.
    askerVideo: mediaUrl(q.asker_video),
    audioTranscript,
    // How the mouth moves saying `audio`, for the jolly that says the question in the joined video.
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
  };
}

function stripPrivate(q) {
  const { planPosition, answerVideo, answerStart, answerTranscript, publishedPosition, publishedAnswerVideo, publishedAnswerStart, publishedAnswerTranscript, publishedQuestionCues, ...rest } = q;
  return rest;
}

/**
 * A published answer as readers see it. `answerStart` is where the answer begins, after the
 * question; `questionCues` caption the question until then, timed from the start of the take.
 */
const publishedAnswer = (q) => ({
  ...stripPrivate(q),
  video: q.publishedAnswerVideo,
  answerStart: q.publishedAnswerStart,
  questionCues: q.publishedQuestionCues,
  transcript: q.publishedAnswerTranscript,
});

/** What readers see: the snapshot taken at the last publish, in the expert's order. */
function publishedAnswers(questions) {
  return questions
    .filter((q) => q.publishedPosition != null)
    .sort((a, b) => a.publishedPosition - b.publishedPosition)
    .map(publishedAnswer);
}

/**
 * The published answers as one video, or null without ffmpeg. `chapters` place each answer in it;
 * `captions` is true where its captions are burned into the picture, so players don't draw them again.
 */
function joinedVideo(oh) {
  if (!oh.video_status) return null;
  const ready = oh.video_status === 'ready';
  const chapters = ready ? JSON.parse(oh.video_chapters).map(([questionId, start, end, captioned]) => ({ questionId, start, end, captions: Boolean(captioned) })) : [];
  return { status: oh.video_status, src: ready ? mediaUrl(oh.video) : null, chapters };
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
// aren't joined into one video.
export function createApp({ db, moderator, devLogin = false, mediaDir = 'media', speech = null, joiner = null }) {
  mkdirSync(mediaDir, { recursive: true });
  const speechJobs = speech ? createSpeechJobs({ db, speech, mediaDir }) : null;
  speechJobs?.resume();
  const videoJobs = joiner ? createVideoJobs({ db, joiner, mediaDir }) : null;
  videoJobs?.resume();
  const routes = [];
  // `raw` routes get the request body unread (ctx.req) instead of parsed JSON.
  const route = (method, pattern, handler, { auth = false, raw = false } = {}) =>
    routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, auth, raw });

  function getOfficeHour(id) {
    const oh = db.prepare('SELECT * FROM office_hours WHERE id = ?').get(Number(id));
    if (!oh) throw new HttpError(404, 'Office hour not found');
    return oh;
  }

  function requireExpert(oh, user) {
    if (oh.expert_id !== user.id) throw new HttpError(403, 'Only the expert can do that');
  }

  // Publishing is final: after that the answers and their order can't change.
  function requireUnpublished(oh) {
    if (oh.published_at) throw new HttpError(409, 'This office hour is published and can no longer be edited');
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

  /** Who may fetch a media file: questions' audio and video and published answers are public; draft answers reach only the expert. */
  function canSeeMedia(name, user) {
    if (db.prepare('SELECT 1 FROM questions WHERE audio = ? OR asker_video = ?').get(name, name)) return true;
    if (db.prepare('SELECT 1 FROM office_hours WHERE video = ?').get(name)) return true; // only set once published
    const owner = db
      .prepare(
        `SELECT q.published_answer_video, oh.expert_id FROM questions q JOIN office_hours oh ON oh.id = q.office_hour_id
         WHERE q.answer_video = ? OR q.published_answer_video = ?`,
      )
      .get(name, name);
    return Boolean(owner && (owner.published_answer_video === name || owner.expert_id === user?.id));
  }

  function subscribe(userId, type, id) {
    db.prepare(
      'INSERT OR IGNORE INTO subscriptions (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)',
    ).run(userId, type, id, now());
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

  route('GET', '/api/me', ({ user }) => ({ user: user ? publicUser(user) : null, devLogin, speech: Boolean(speech) }));

  // Dev-only user switcher: log in as anyone without a password. Off unless explicitly enabled.
  if (devLogin) {
    route('GET', '/api/dev/users', () => ({
      users: db.prepare('SELECT * FROM users ORDER BY username').all().map(({ id, username, display_name }) => ({ id, username, displayName: display_name })),
    }));

    route('POST', '/api/dev/login', ({ body, setSession }) => {
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(body.username ?? ''));
      if (!user) throw new HttpError(404, 'User not found');
      setSession(user.id);
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
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO office_hours
             (expert_id, title, topic, description, questions_deadline, answers_expected_at, allow_anonymous, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(user.id, title, topic, description, deadline, answersAt, body.allowAnonymous ? 1 : 0, now());
      return { officeHour: serializeOfficeHour(db, getOfficeHour(lastInsertRowid), user) };
    },
    { auth: true },
  );

  route('GET', '/api/office-hours/:id', ({ params, user }) => {
    const oh = getOfficeHour(params.id);
    const officeHour = serializeOfficeHour(db, oh, user);
    const { questions, order } = moderatedView(oh, user);
    const isExpert = officeHour.isExpert;
    const visible = isExpert ? questions : questions.map(stripPrivate);
    const byId = new Map(visible.map((q) => [q.id, q]));
    const result = {
      officeHour,
      groups: order.groups.map((g) => ({ label: g.label, popularity: g.popularity, questions: g.questionIds.map((id) => byId.get(id)) })),
      answers: officeHour.status === 'published' ? publishedAnswers(questions).map(withSummary) : [],
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

  route(
    'POST',
    '/api/office-hours/:id/questions',
    // A typed question has a `body`. A spoken one, or one asked on camera, names its `recording`
    // (see below) and sends the transcript lines as the asker checked them, in `cues`; that
    // transcript is the question text.
    ({ params, user, body }) => {
      const oh = getOfficeHour(params.id);
      if (statusOf(oh) !== 'open') throw new HttpError(409, 'This office hour is no longer taking questions');
      const anonymous = Boolean(body.anonymous);
      if (anonymous && !oh.allow_anonymous) throw new HttpError(400, 'Anonymous questions are not enabled for this office hour');
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
      const id = transaction(db, () => {
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO questions (office_hour_id, author_id, source, is_anonymous, body, asked_with, audio, audio_status, asker_video, created_at)
             VALUES (?, ?, 'asker', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(oh.id, user.id, anonymous ? 1 : 0, text, recording ? 'audio' : 'text', recording, recording ? 'ready' : null, video, now());
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
      if (statusOf(oh) !== 'open') throw new HttpError(409, 'This office hour is no longer taking questions');
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
      if (!Array.isArray(body.questions) || body.questions.length === 0) throw new HttpError(400, 'questions must be a non-empty array');
      const texts = body.questions.slice(0, 20).map((q) => str(q, 'Question', { min: 5, max: 500 }));
      const insert = db.prepare(
        "INSERT INTO questions (office_hour_id, author_id, source, body, created_at) VALUES (?, NULL, 'moderator', ?, ?)",
      );
      const ids = transaction(db, () => texts.map((t) => Number(insert.run(oh.id, t, now()).lastInsertRowid)));
      ids.forEach((id) => speechJobs?.speak(id));
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
        if (!valid.has(id)) throw new HttpError(400, `Question ${item?.questionId} is not part of this office hour`);
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
      const current = db.prepare('SELECT answer_video FROM questions WHERE id = ?').get(q.id);
      try {
        requireUnpublished(getOfficeHour(q.office_hour_id));
      } catch (err) {
        pruneVideos([name]);
        throw err;
      }
      db.prepare('UPDATE questions SET answer_video = ?, answer_start = ? WHERE id = ?').run(name, answerStart, q.id);
      pruneVideos([current.answer_video]);
      speechJobs?.transcribe(name);
      return { video: mediaUrl(name), transcript: answerTranscriptOf(db, name, answerStart) };
    },
    { auth: true, raw: true },
  );

  route(
    'DELETE',
    '/api/questions/:id/video',
    ({ params, user }) => {
      const q = editableQuestion(params.id, user);
      db.prepare('UPDATE questions SET answer_video = NULL, answer_start = NULL WHERE id = ?').run(q.id);
      pruneVideos([q.answer_video]);
      return { video: null };
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
      const working = workingAnswers(loadQuestions(db, oh.id, user));
      if (working.length === 0) throw new HttpError(400, 'Record an answer for at least one queued question before publishing');
      const t = now();
      const unused = transaction(db, () => {
        const snapshot = db.prepare('UPDATE questions SET published_position = ?, published_answer_video = answer_video, published_answer_start = answer_start WHERE id = ?');
        working.forEach(([id], i) => snapshot.run(i + 1, id));
        db.prepare('UPDATE office_hours SET published_at = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?').run(t, t, oh.id);
        // Videos recorded for questions that didn't make the cut can never be published now.
        const leftover = 'FROM questions WHERE office_hour_id = ? AND published_position IS NULL AND answer_video IS NOT NULL';
        const names = db.prepare(`SELECT answer_video ${leftover}`).all(oh.id).map((r) => r.answer_video);
        db.prepare(`UPDATE questions SET answer_video = NULL, answer_start = NULL WHERE id IN (SELECT id ${leftover})`).run(oh.id);
        return names;
      });
      pruneVideos(unused);
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
  // who gets what. Supports Range requests, which browsers need to seek (and Safari needs to
  // play at all).
  async function serveMedia(req, res, pathname, user) {
    const path = pathname.slice('/media/'.length);
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
    const file = join(mediaDir, name);
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
      'Content-Type': MIME[extname(name)],
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-cache',
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).pipe(res);
  }

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = normalize(join(PUBLIC_DIR, rel));
    try {
      if (!file.startsWith(PUBLIC_DIR) || rel.split(/[\\/]/).includes('..')) throw new Error('outside public dir');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      // Unknown paths get the SPA shell; routing happens client-side via the hash.
      const data = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(pathname.includes('.') && !pathname.endsWith('.html') ? 404 : 200, { 'Content-Type': MIME['.html'] });
      res.end(data);
    }
  }

  function sendJson(res, status, payload, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(payload));
  }

  // `idle()` resolves when background speech and video work is done (for tests).
  return Object.assign(handle, { idle: () => Promise.all([speechJobs?.idle(), videoJobs?.idle()]) });

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
        setSession(userId) {
          const { token, maxAge } = createSession(db, userId);
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
