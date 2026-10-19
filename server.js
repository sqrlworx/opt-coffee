import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { createBroll } from './src/broll/index.js';
import { createModerator } from './src/moderator/index.js';
import { createSpeech } from './src/speech/index.js';
import { createFinisher } from './src/finish/index.js';
import { createVideoJoiner } from './src/video.js';

// API keys and settings can go in a .env file; variables already set in the environment win.
if (existsSync('.env')) process.loadEnvFile('.env');
const port = Number(process.env.PORT ?? 3000);
const db = openDb(process.env.FORUM_DB ?? 'forum.db');
const mediaDir = process.env.FORUM_MEDIA ?? 'media';
const moderator = await createModerator();
const speech = createSpeech();
speech?.warmup();
const finisher = createFinisher();
const joiner = createVideoJoiner({ finisher });
const broll = createBroll();
// Lets anyone log in as any user without a password. Local development only.
const devLogin = process.argv.includes('--dev') || process.env.FORUM_DEV_LOGIN === '1';

createServer(createApp({ db, moderator, devLogin, mediaDir, speech, joiner, broll })).listen(port, () => {
  console.log(`off hours listening on http://localhost:${port} (moderator: ${moderator.name}; speech: ${speech?.name ?? 'off'}; joining answer videos: ${joiner ? (finisher ? 'on, finished' : 'on') : 'off'}; b-roll: ${broll?.name ?? 'off'})`);
  if (devLogin) console.warn('dev login is ON: anyone can switch to any user. Never enable this in production.');
});
