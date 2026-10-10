import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  expertise     TEXT NOT NULL DEFAULT '',   -- comma-separated tags
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
  video_status        TEXT,                 -- joining them: 'pending' | 'ready' | 'failed'; NULL before publishing, or without ffmpeg
  video_chapters      TEXT                  -- JSON [[question_id, start, end], ...]: where each answer is in the video, in seconds
);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY,
  office_hour_id INTEGER NOT NULL REFERENCES office_hours(id) ON DELETE CASCADE,
  author_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- NULL for moderator seeds
  source         TEXT NOT NULL DEFAULT 'asker' CHECK (source IN ('asker', 'moderator')),
  is_anonymous   INTEGER NOT NULL DEFAULT 0,
  body           TEXT NOT NULL,             -- for questions asked out loud, the transcript
  asked_with     TEXT NOT NULL DEFAULT 'text' CHECK (asked_with IN ('text', 'audio')),
  audio          TEXT,                      -- the question as speech: the asker's recording, or the text read aloud (file in the media dir)
  audio_status   TEXT,                      -- reading a typed question aloud: 'pending' | 'ready' | 'failed'; NULL when speech is off
  created_at     TEXT NOT NULL,
  plan_position  INTEGER,                   -- expert's working answer order; NULL = not selected
  answer_video   TEXT,                      -- expert's working (draft) video answer: file name in the media dir
  answer_start   REAL,                      -- seconds into answer_video where the answer begins (after the question is played); NULL = from the start
  published_position     INTEGER,           -- snapshot taken at publish time: what readers see
  published_answer_video TEXT,
  published_answer_start REAL
);
CREATE INDEX IF NOT EXISTS questions_by_oh ON questions(office_hour_id);

-- Speech-to-text for a recording: an answer video or a question asked out loud. Keyed by file, so
-- a draft answer and its published snapshot share one transcript.
CREATE TABLE IF NOT EXISTS transcripts (
  media      TEXT PRIMARY KEY,                -- file name in the media dir
  status     TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  text       TEXT,
  cues       TEXT,                            -- JSON [[start, end, text], ...]; served as WebVTT at /media/<media>.vtt
  edited_at  TEXT,                            -- last hand correction of the text
  updated_at TEXT NOT NULL
);

-- A spoken question that's been recorded and transcribed, waiting for the asker to check the
-- transcript and ask. Removed when asked, discarded, or after a day.
CREATE TABLE IF NOT EXISTS recordings (
  media          TEXT PRIMARY KEY,            -- file name in the media dir; its transcript is in transcripts
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
  const officeHourColumns = new Set(db.prepare('PRAGMA table_info(office_hours)').all().map((c) => c.name));
  if (!officeHourColumns.has('video')) {
    // Published answers became one video. Office hours published before that are joined on startup.
    db.exec(`
      ALTER TABLE office_hours ADD COLUMN video TEXT;
      ALTER TABLE office_hours ADD COLUMN video_status TEXT;
      ALTER TABLE office_hours ADD COLUMN video_chapters TEXT;
    `);
  }
  const transcriptColumns = new Set(db.prepare('PRAGMA table_info(transcripts)').all().map((c) => c.name));
  if (!transcriptColumns.has('edited_at')) db.exec('ALTER TABLE transcripts ADD COLUMN edited_at TEXT');
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
