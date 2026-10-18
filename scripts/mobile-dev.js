// The mobile app with hot reload (npm run mobile:dev): Vite serves it on port 5173 and passes the
// API and media through to the forum server, which it starts too (as `npm run dev` does) unless one
// is already answering at FORUM_URL. Ctrl-C stops both.
import { spawn } from 'node:child_process';

const forum = process.env.FORUM_URL ?? 'http://localhost:3000';
const running = await fetch(`${forum}/api/me`).then((res) => res.ok, () => false);
const children = [];
const start = (cmd, args, env = {}) => {
  const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => stop(code ?? 0));
  children.push(child);
};
function stop(code) {
  for (const child of children) if (child.exitCode == null) child.kill();
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (running) console.log(`Using the forum server already running at ${forum}`);
else start(process.execPath, ['server.js', '--dev'], { PORT: new URL(forum).port || '80' });
start('npm', ['--prefix', 'mobile', 'run', 'dev'], { FORUM_URL: forum });
