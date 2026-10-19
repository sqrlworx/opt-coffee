import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  expertise     TEXT NOT NULL DEFAULT '',   -- comma-separated tags
  voice         TEXT,                       -- the voice they last picked to read their typed questions aloud; NULL = the server's default
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS office_hours (
  id                  INTEGER PRIMARY KEY,
  expert_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  topic               TEXT,                 -- optional
  description         TEXT NOT NULL DEFAULT '',
  questions_deadline  TEXT NOT NULL,        -- askers can submit until this time
  answers_expected_at TEXT NOT NULL,        -- informational only
  allow_anonymous     INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,        -- "announced" time
  closed_at           TEXT,                 -- expert closed questions early
  published_at        TEXT,
  video               TEXT,                 -- the published answers joined into one video (file in the media dir)
  video_mobile         TEXT,                 -- its copy for the mobile app: upright (3:4, or 9:16 when every take is), with full-screen b-roll but not split-screen b-roll, burned-in captions placed for its split screen; NULL if joined before there were copies
  video_status        TEXT,                 -- joining them: 'pending' | 'ready' | 'failed'; NULL before publishing, or without ffmpeg
  follow_up_of        INTEGER REFERENCES office_hours(id) ON DELETE SET NULL,  -- picks up the discussion of this (published) office hour
  video_chapters      TEXT                  -- JSON [[question_id, start, end, captioned, question_start, expert_focus, asker_focus], ...]: where each answer is in the video, in seconds; captioned = 1 when its captions are burned into the picture; question_start: how far into the answer its question's sound starts (a take records it a little late); expert_focus, asker_focus: where the phone's halves crop the expert in its copy and the asker's video to frame their faces (CSS object-position, 0-1 down), or null
);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY,
  office_hour_id INTEGER NOT NULL REFERENCES office_hours(id) ON DELETE CASCADE,
  author_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL for moderator seeds
  source         TEXT NOT NULL DEFAULT 'asker' CHECK (source IN ('asker', 'moderator')),
  is_anonymous   INTEGER NOT NULL DEFAULT 0,
  body           TEXT NOT NULL,             -- for questions asked out loud, the transcript
  asked_with     TEXT NOT NULL DEFAULT 'text' CHECK (asked_with IN ('text', 'audio')),  -- 'audio' also for questions asked on camera
  audio          TEXT,                      -- the question as speech: the asker's recording, or the text read aloud (file in the media dir)
  asker_video    TEXT,                      -- a question asked on camera: the asker's video (file in the media dir); its sound is also in audio
  audio_status   TEXT,                      -- reading a typed question aloud: 'pending' | 'ready' | 'failed'; NULL when speech is off
  voice          TEXT,                      -- the Kokoro voice a typed question is read aloud in; NULL = the server's default
  lip_sync       TEXT,                      -- how the mouth moves saying audio, for the fox that says it in the joined video: JSON {fps, frames: [[open, width, energy], ...]}; NULL until made
  created_at     TEXT NOT NULL,
  plan_position  INTEGER,                   -- expert's working answer order; NULL = not selected
  answer_video   TEXT,                      -- expert's working (draft) video answer: file name in the media dir
  answer_start   REAL,                      -- seconds into answer_video where the answer begins (after the question is played); NULL = from the start
  broll_prompt   TEXT,                      -- the expert's description of b-roll to cut away to during the answer; for a clip they uploaded, what it shows, if they said
  broll_shot     TEXT,                      -- the shot that was filmed for it: the description written up as something a video model can film
  broll_upload   TEXT,                      -- b-roll the expert uploaded instead: their file's name; NULL when it's made from broll_prompt
  broll_status   TEXT,                      -- making it (or getting an upload ready) and placing it in the take: 'pending' | 'ready' | 'failed'; NULL = no b-roll
  broll_video    TEXT,                      -- the b-roll clip (file in the media dir); named when it's asked for, so it may not exist until ready
  broll_start    REAL,                      -- seconds into answer_video where it cuts away to the b-roll
  broll_length   REAL,                      -- seconds the b-roll plays for, from its start (no longer than the clip, and shorter than the answer)
  broll_full     INTEGER NOT NULL DEFAULT 0, -- 1: full screen, for a clip the expert uploaded: it fills the page's frame with the expert in the corner, and the phone's whole player; 0: split screen, the expert beside it on the page and above it on the phone
  published_position     INTEGER,           -- snapshot taken at publish time: what readers see
  published_answer_video TEXT,
  published_answer_start REAL,
  published_broll        TEXT,              -- the b-roll as published, if it was ready and placed: its clip, start, length and whether it's full screen
  published_broll_start  REAL,
  published_broll_length REAL,
  published_broll_full   INTEGER
);
CREATE INDEX IF NOT EXISTS questions_by_oh ON questions(office_hour_id);

-- Speech-to-text for a recording: an answer video or a question asked out loud. Keyed by file, so
-- a draft answer and its published snapshot share one transcript.
CREATE TABLE IF NOT EXISTS transcripts (
  media      TEXT PRIMARY KEY,                -- file name in the media dir
  status     TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  text       TEXT,
  cues       TEXT,                            -- JSON [[start, end, text], ...]; served as WebVTT at /media/<media>.vtt
  words      TEXT,                            -- JSON [[start, end, word], ...] from speech-to-text, for captions timed word by word
  edited_at  TEXT,                            -- last hand correction of the text
  updated_at TEXT NOT NULL
);

-- A spoken question that's been recorded and transcribed, waiting for the asker to check the
-- transcript and ask. Removed when asked, discarded, or after a day.
CREATE TABLE IF NOT EXISTS recordings (
  media          TEXT PRIMARY KEY,            -- file name in the media dir; its transcript is in transcripts
  video          TEXT,                        -- recorded on camera: the video, whose sound is media
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  office_hour_id INTEGER NOT NULL REFERENCES office_hours(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (question_id, user_id)
);

-- The discussion under a published answer. Text only, and two levels at most: a reply to the
-- answer, and the expert responding to one of those replies.
CREATE TABLE IF NOT EXISTS replies (
  id          INTEGER PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,  -- the answered question
  parent_id   INTEGER REFERENCES replies(id) ON DELETE CASCADE,             -- NULL: a reply to the answer; else the expert responding to that reply
  author_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_by_question ON replies(question_id);

CREATE TABLE IF NOT EXISTS reply_likes (
  reply_id   INTEGER NOT NULL REFERENCES replies(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (reply_id, user_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('expert', 'office_hour')),
  target_id   INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_by_target ON subscriptions(target_type, target_id);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Bring databases created by earlier versions up to the current schema.
function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name));
  if (!columns.has('published_position')) {
    // Before drafts existed, the working answers *were* the published ones.
    db.exec(`
      ALTER TABLE questions ADD COLUMN published_position INTEGER;
      ALTER TABLE questions ADD COLUMN published_answer TEXT;
      UPDATE questions SET published_position = plan_position, published_answer = answer
      WHERE plan_position IS NOT NULL AND TRIM(COALESCE(answer, '')) != ''
        AND office_hour_id IN (SELECT id FROM office_hours WHERE published_at IS NOT NULL);
    `);
  }
  if (!columns.has('answer_video')) {
    // Answers became recorded videos. Old text answers stay in their columns but are no longer shown.
    db.exec(`
      ALTER TABLE questions ADD COLUMN answer_video TEXT;
      ALTER TABLE questions ADD COLUMN published_answer_video TEXT;
    `);
  }
  if (!columns.has('asked_with')) {
    // Questions gained speech: asked out loud, or typed and read aloud.
    db.exec(`
      ALTER TABLE questions ADD COLUMN asked_with TEXT NOT NULL DEFAULT 'text' CHECK (asked_with IN ('text', 'audio'));
      ALTER TABLE questions ADD COLUMN audio TEXT;
      ALTER TABLE questions ADD COLUMN audio_status TEXT;
    `);
  }
  if (!columns.has('answer_start')) {
    // Answers recorded in a session start with the question being played.
    db.exec(`
      ALTER TABLE questions ADD COLUMN answer_start REAL;
      ALTER TABLE questions ADD COLUMN published_answer_start REAL;
    `);
  }
  if (!columns.has('asker_video')) {
    // Questions can be asked on camera.
    db.exec('ALTER TABLE questions ADD COLUMN asker_video TEXT');
  }
  // Questions' speech gained lip sync; questions with audio get theirs on startup.
  if (!columns.has('lip_sync')) db.exec('ALTER TABLE questions ADD COLUMN lip_sync TEXT');
  // Askers pick the voice their typed question is read aloud in.
  if (!columns.has('voice')) db.exec('ALTER TABLE questions ADD COLUMN voice TEXT');
  if (!columns.has('broll_status')) {
    // Experts can add b-roll to their answers.
    db.exec(`
      ALTER TABLE questions ADD COLUMN broll_prompt TEXT;
      ALTER TABLE questions ADD COLUMN broll_status TEXT;
      ALTER TABLE questions ADD COLUMN broll_video TEXT;
      ALTER TABLE questions ADD COLUMN broll_start REAL;
      ALTER TABLE questions ADD COLUMN broll_length REAL;
      ALTER TABLE questions ADD COLUMN published_broll TEXT;
      ALTER TABLE questions ADD COLUMN published_broll_start REAL;
      ALTER TABLE questions ADD COLUMN published_broll_length REAL;
    `);
  }
  // B-roll is written up as a shot before it's filmed.
  if (!columns.has('broll_shot')) db.exec('ALTER TABLE questions ADD COLUMN broll_shot TEXT');
  // Experts can upload b-roll of their own.
  if (!columns.has('broll_upload')) db.exec('ALTER TABLE questions ADD COLUMN broll_upload TEXT');
  if (!columns.has('broll_full')) {
    // B-roll they upload can be full screen instead of split screen.
    db.exec(`
      ALTER TABLE questions ADD COLUMN broll_full INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE questions ADD COLUMN published_broll_full INTEGER;
    `);
  }
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!userColumns.has('voice')) db.exec('ALTER TABLE users ADD COLUMN voice TEXT');
  const recordingColumns = new Set(db.prepare('PRAGMA table_info(recordings)').all().map((c) => c.name));
  if (!recordingColumns.has('video')) db.exec('ALTER TABLE recordings ADD COLUMN video TEXT');
  const officeHourColumns = new Set(db.prepare('PRAGMA table_info(office_hours)').all().map((c) => c.name));
  if (!officeHourColumns.has('video')) {
    // Published answers became one video. Office hours published before that are joined on startup.
    db.exec(`
      ALTER TABLE office_hours ADD COLUMN video TEXT;
      ALTER TABLE office_hours ADD COLUMN video_status TEXT;
      ALTER TABLE office_hours ADD COLUMN video_chapters TEXT;
    `);
  }
  // The mobile app gets its own copy of the joined video, with captions placed for its split screen.
  if (!officeHourColumns.has('video_mobile')) db.exec('ALTER TABLE office_hours ADD COLUMN video_mobile TEXT');
  // Office hours can follow up on an earlier one's discussion.
  if (!officeHourColumns.has('follow_up_of')) db.exec('ALTER TABLE office_hours ADD COLUMN follow_up_of INTEGER REFERENCES office_hours(id) ON DELETE SET NULL');
  const transcriptColumns = new Set(db.prepare('PRAGMA table_info(transcripts)').all().map((c) => c.name));
  if (!transcriptColumns.has('edited_at')) db.exec('ALTER TABLE transcripts ADD COLUMN edited_at TEXT');
  if (!transcriptColumns.has('words')) db.exec('ALTER TABLE transcripts ADD COLUMN words TEXT');
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
