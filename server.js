import { createServer } from 'node:http';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { createModerator } from './src/moderator/index.js';
import { createSpeech } from './src/speech/index.js';
import { createFinisher } from './src/finish/index.js';
import { createVideoJoiner } from './src/video.js';

const port = Number(process.env.PORT ?? 3000);
const db = openDb(process.env.FORUM_DB ?? 'forum.db');
const mediaDir = process.env.FORUM_MEDIA ?? 'media';
const moderator = await createModerator();
const speech = createSpeech();
speech?.warmup();
const finisher = createFinisher();
const joiner = createVideoJoiner({ finisher });
// Lets anyone log in as any user without a password. Local development only.
const devLogin = process.argv.includes('--dev') || process.env.FORUM_DEV_LOGIN === '1';

createServer(createApp({ db, moderator, devLogin, mediaDir, speech, joiner })).listen(port, () => {
  console.log(`forum listening on http://localhost:${port} (moderator: ${moderator.name}; speech: ${speech?.name ?? 'off'}; joining answer videos: ${joiner ? (finisher ? 'on, finished' : 'on') : 'off'})`);
  if (devLogin) console.warn('dev login is ON: anyone can switch to any user. Never enable this in production.');
});
