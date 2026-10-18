import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into dist/, which the forum server serves at /m/. `npm run dev` serves it on port 5173 with
// hot reload instead, passing the API and media through to the forum server (FORUM_URL). `npm run
// mobile:dev` in the repo root starts that server too.
const forum = process.env.FORUM_URL ?? 'http://localhost:3000';

// When the forum server isn't there, the app says so (it shows the API's error), rather than a bare 502.
const target = {
  target: forum,
  configure(proxy) {
    proxy.on('error', (err, req, res) => {
      if (res.headersSent || res.writableEnded || typeof res.writeHead !== 'function') return;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `the forum server isn't running at ${forum}. Start it with "npm run dev" in the repo root, or run "npm run mobile:dev" there to start both.` }));
    });
  },
};

export default defineConfig({
  base: '/m/',
  plugins: [react()],
  resolve: {
    alias: { 'react-native': 'react-native-web' },
    extensions: ['.web.js', '.web.jsx', '.js', '.jsx', '.json'],
  },
  server: {
    port: 5173,
    proxy: { '/api': target, '/media': target, '/fox.webp': target },
    fs: { allow: ['..'] }, // the fox is shared with the page, in ../public/fox.js
  },
});
