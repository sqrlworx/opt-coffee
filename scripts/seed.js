// Populate a demo database. Usage: npm run seed  (FORUM_DB=path to override; wipes existing data)
import { rmSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const path = process.env.FORUM_DB ?? 'forum.db';
for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
rmSync(process.env.FORUM_MEDIA ?? 'media', { recursive: true, force: true }); // recorded answers belong to the old database
const db = openDb(path);

const t = (days) => new Date(Date.now() + days * 86400_000).toISOString();
const password = hashPassword('password123');

const users = {};
for (const [username, displayName, bio, expertise] of [
  ['maya', 'Maya Okafor', 'Staff engineer. Spent 12 years building storage and distributed databases; now mentoring new tech leads.', 'distributed systems, databases, career growth'],
  ['leo', 'Leo Brandt', 'Product designer turned design manager. Previously led design for a fintech app with 20M users.', 'product design, design leadership, portfolios'],
  ['sam', 'Sam Rivera', 'Curious engineer, two years in.', ''],
  ['priya', 'Priya Nair', 'Data scientist working on recommendations.', 'machine learning'],
  ['jo', 'Jo Kim', '', ''],
]) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (username, display_name, password_hash, bio, expertise, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, displayName, password, bio, expertise, t(-30));
  users[username] = Number(lastInsertRowid);
}

function officeHour(expert, fields) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO office_hours (expert_id, title, topic, description, questions_deadline, answers_expected_at,
         allow_anonymous, created_at, closed_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(users[expert], fields.title, fields.topic ?? null, fields.description ?? '', fields.deadline, fields.answersAt, fields.anon ? 1 : 0, fields.createdAt, fields.closedAt ?? null, fields.publishedAt ?? null);
  return Number(lastInsertRowid);
}

function question(ohId, author, body, { anon = false, voters = [], position = null, createdAt } = {}) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO questions (office_hour_id, author_id, source, is_anonymous, body, created_at, plan_position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ohId, author ? users[author] : null, author ? 'asker' : 'moderator', anon ? 1 : 0, body, createdAt, position);
  for (const v of voters) db.prepare('INSERT INTO votes (question_id, user_id, created_at) VALUES (?, ?, ?)').run(lastInsertRowid, users[v], createdAt);
}

function subscribe(user, type, id) {
  db.prepare('INSERT INTO subscriptions (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)').run(users[user], type, id, t(-20));
}

// Subscriptions
subscribe('sam', 'expert', users.maya);
subscribe('sam', 'expert', users.leo);
subscribe('priya', 'expert', users.maya);
subscribe('jo', 'expert', users.maya);
subscribe('maya', 'expert', users.leo);

// 1) Closed office hour, answer order picked, ready for Maya to record her video answers
// (answers are recorded live in the browser, so the seed can't include any).
const past = officeHour('maya', {
  title: 'From senior to staff: ask me anything',
  topic: 'Career growth',
  description: 'Promotion, scope, influence without authority — bring your questions.',
  deadline: t(-1),
  answersAt: t(1),
  createdAt: t(-5),
  closedAt: t(-1),
  anon: true,
});
question(past, 'sam', 'What actually changed in your day-to-day when you became staff?', { voters: ['priya', 'jo', 'leo'], position: 1, createdAt: t(-4) });
question(past, 'priya', 'How did you find staff-level scope on a team that already had a tech lead?', { voters: ['sam'], position: 2, createdAt: t(-3) });
question(past, 'jo', 'What do promotion committees look for in a staff packet?', { anon: true, voters: ['sam', 'priya'], position: 3, createdAt: t(-3) });
question(past, 'sam', 'Do you still get to code?', { createdAt: t(-2) });

// 2) Open office hour with grouped questions
const open = officeHour('maya', {
  title: 'Distributed databases off hours',
  topic: 'Databases',
  description: 'Replication, consistency, picking a database for your project. Nothing is too basic.',
  deadline: t(3),
  answersAt: t(5),
  createdAt: t(-1),
  anon: true,
});
question(open, null, 'What is the most common mistake you see people make with databases?', { voters: ['sam', 'priya'], createdAt: t(-0.9) });
question(open, 'sam', 'How do I choose between Postgres and MySQL for a new project database?', { voters: ['priya', 'jo', 'leo'], createdAt: t(-0.8) });
question(open, 'jo', 'Which database would you pick for an early-stage startup: Postgres, MySQL, or something else?', { voters: ['sam'], createdAt: t(-0.7) });
question(open, 'priya', 'How do you reason about consistency vs availability tradeoffs in replication?', { voters: ['sam', 'jo'], createdAt: t(-0.6) });
question(open, 'leo', 'When is eventual consistency acceptable for replication, and when is it dangerous?', { anon: true, createdAt: t(-0.5) });
question(open, 'jo', 'How did you get into distributed systems work in the first place?', { createdAt: t(-0.4) });

// 3) Open-topic office hour by Leo
officeHour('leo', {
  title: 'Portfolio reviews & design careers',
  description: 'Open topic — portfolios, interviews, moving into management, whatever is on your mind.',
  deadline: t(6),
  answersAt: t(8),
  createdAt: t(-0.2),
});

console.log(`Seeded ${path}. Log in as maya, leo, sam, priya or jo — password: password123`);
