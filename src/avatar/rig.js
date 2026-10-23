import { spawn } from 'node:child_process';

/**
 * Rigging a character so players can animate it as they do the fox (public/fox.js): its eyes and
 * mouth are found in its picture, near where the LLM saw them, then painted out, so the players can
 * draw them blinking and talking instead. The rig says where they go, and what of the picture to
 * show.
 *
 * Pictures here are {width, height, data}: data is RGBA, 4 bytes a pixel, row by row.
 */

const PNG_SIGNATURE = '89504e470d0a1a0a';
const FFMPEG_TIMEOUT = 60_000;
const DARK = 0.5; // a pixel is dark when it's this far from the darkest in its window towards the most common
const MAX_DARK = 110; // and never lighter than this (0-255)
const MARGIN = 0.06; // of the picture's width kept clear around what's shown, for the character to sway into
export const PICTURE_SIZE = 256; // pixels square, the profile picture

const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
const round = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const hex = ([r, g, b]) => `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** The part of `img` in a box [left, top, right, bottom], clamped to the picture: {x, y, w, h}. */
function within(img, [l, t, r, b]) {
  const x = clamp(Math.floor(l), 0, img.width - 1);
  const y = clamp(Math.floor(t), 0, img.height - 1);
  return { x, y, w: clamp(Math.ceil(r), x + 1, img.width) - x, h: clamp(Math.ceil(b), y + 1, img.height) - y };
}

/**
 * The dark pixels in a window of `img`, as a mask over the window: those well on the way from the
 * darkest there to the most common brightness (the skin, fur or paint around a feature).
 */
function darkIn(img, win) {
  const lumas = new Uint8Array(win.w * win.h);
  const histogram = new Uint32Array(256);
  for (let y = 0; y < win.h; y++) {
    for (let x = 0; x < win.w; x++) {
      const v = Math.round(luma(img.data, ((win.y + y) * img.width + win.x + x) * 4));
      lumas[y * win.w + x] = v;
      histogram[v]++;
    }
  }
  let darkest = 0;
  while (!histogram[darkest]) darkest++;
  let median = 0;
  for (let seen = 0; seen + histogram[median] < lumas.length / 2; median++) seen += histogram[median];
  const threshold = Math.min(MAX_DARK, darkest + DARK * (median - darkest));
  return lumas.map((v) => (v <= threshold ? 1 : 0));
}

/** The connected parts (4-neighbour) of a mask over a window: each its pixels (indices into the window) and bounds. */
function components(mask, win) {
  const seen = new Uint8Array(mask.length);
  const found = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [start];
    seen[start] = 1;
    let [minX, maxX, minY, maxY, sumX, sumY] = [Infinity, -Infinity, Infinity, -Infinity, 0, 0];
    for (let k = 0; k < pixels.length; k++) {
      const i = pixels[k];
      const x = i % win.w;
      const y = (i - x) / win.w;
      [minX, maxX, minY, maxY] = [Math.min(minX, x), Math.max(maxX, x), Math.min(minY, y), Math.max(maxY, y)];
      sumX += x;
      sumY += y;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= win.w || ny >= win.h) continue;
        const n = ny * win.w + nx;
        if (mask[n] && !seen[n]) {
          seen[n] = 1;
          pixels.push(n);
        }
      }
    }
    found.push({ pixels, minX, maxX, minY, maxY, cx: sumX / pixels.length, cy: sumY / pixels.length });
  }
  return found;
}

/** The pixels a blob encloses (an eye's highlight, say): those inside its bounds that can't reach their edge around it. */
function holesIn(blob, win) {
  const w = blob.maxX - blob.minX + 3;
  const h = blob.maxY - blob.minY + 3;
  const wall = new Uint8Array(w * h); // the blob, in its bounds with a pixel's border
  for (const i of blob.pixels) {
    const x = i % win.w;
    wall[((i - x) / win.w - blob.minY + 1) * w + x - blob.minX + 1] = 1;
  }
  const outside = new Uint8Array(w * h);
  const queue = [0];
  outside[0] = 1;
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k];
    const x = i % w;
    const y = (i - x) / w;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      const n = ny * w + nx;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && !wall[n] && !outside[n]) {
        outside[n] = 1;
        queue.push(n);
      }
    }
  }
  const holes = new Uint8Array(win.w * win.h);
  for (let i = 0; i < w * h; i++) {
    if (wall[i] || outside[i]) continue;
    const x = i % w;
    holes[((i - x) / w + blob.minY - 1) * win.w + x + blob.minX - 1] = 1;
  }
  return holes;
}

/** Mean, variances and covariance of pixels (indices into a window), in the picture's coordinates. */
function moments(pixels, win) {
  let [sx, sy] = [0, 0];
  for (const i of pixels) {
    sx += i % win.w;
    sy += Math.floor(i / win.w);
  }
  const [mx, my] = [sx / pixels.length, sy / pixels.length];
  let [vxx, vyy, vxy] = [0, 0, 0];
  for (const i of pixels) {
    const dx = (i % win.w) - mx;
    const dy = Math.floor(i / win.w) - my;
    vxx += dx * dx;
    vyy += dy * dy;
    vxy += dx * dy;
  }
  const n = pixels.length;
  return { x: win.x + mx, y: win.y + my, vxx: vxx / n, vyy: vyy / n, vxy: vxy / n };
}

/** The average colour of pixels (indices into a window) in `img`, as [r, g, b]. */
function colourOf(img, pixels, win) {
  const sum = [0, 0, 0];
  for (const i of pixels) {
    const p = ((win.y + Math.floor(i / win.w)) * img.width + win.x + (i % win.w)) * 4;
    for (let c = 0; c < 3; c++) sum[c] += img.data[p + c];
  }
  return sum.map((s) => s / pixels.length);
}

// Pixels of a window, as indices into the whole picture.
const inPicture = (pixels, win, img) => pixels.map((i) => (win.y + Math.floor(i / win.w)) * img.width + win.x + (i % win.w));

/**
 * The eye near `box` ([left, top, right, bottom], where the LLM saw it): a solid dark oval, its
 * highlight (the largest light patch inside it) and its colours. Null when there's no dark oval
 * about that size there, as for an eye drawn with an iris, or merged into an outline.
 * @returns {{at: number[], r: number[], shine: number[]|null, ink: string, shineColor: string|null, pixels: number[]}|null}
 */
export function findEye(img, [l, t, r, b]) {
  const [bw, bh] = [r - l, b - t];
  if (!(bw > 2 && bh > 2)) return null;
  const win = within(img, [l - 0.6 * bw, t - 0.6 * bh, r + 0.6 * bw, b + 0.6 * bh]);
  const expected = (Math.PI / 4) * bw * bh;
  const [cx, cy] = [(l + r) / 2 - win.x, (t + b) / 2 - win.y];
  const near = (c) => Math.hypot(c.cx - cx, c.cy - cy);
  const blob = components(darkIn(img, win), win)
    .filter((c) => c.pixels.length > 0.25 * expected && c.pixels.length < 3 * expected && near(c) < Math.max(bw, bh))
    .sort((a, z) => near(a) - near(z))[0];
  if (!blob) return null;
  const holes = holesIn(blob, win);
  const inside = [...blob.pixels, ...holes.keys().filter((i) => holes[i])];
  // A filled ellipse's variance along an axis is a quarter of its radius squared.
  const m = moments(inside, win);
  const [rx, ry] = [2 * Math.sqrt(m.vxx), 2 * Math.sqrt(m.vyy)];
  const fill = inside.length / (Math.PI * rx * ry);
  if (rx < 3 || ry < 3 || fill < 0.85 || fill > 1.15) return null;
  // The highlight: the largest patch inside, as an ellipse along its own axes.
  const patch = components(holes, win).sort((a, z) => z.pixels.length - a.pixels.length)[0];
  let shine = null;
  let shineColor = null;
  if (patch?.pixels.length >= 4) {
    const s = moments(patch.pixels, win);
    const mid = (s.vxx + s.vyy) / 2;
    const spread = Math.sqrt(((s.vxx - s.vyy) / 2) ** 2 + s.vxy ** 2);
    const angle = 0.5 * Math.atan2(2 * s.vxy, s.vxx - s.vyy);
    // A little past two deviations, since the players' highlight fades out towards its edge.
    shine = [round(s.x), round(s.y), round(2.2 * Math.sqrt(mid + spread)), round(Math.max(1, 2.2 * Math.sqrt(Math.max(0, mid - spread)))), Math.round(angle * 100) / 100];
    shineColor = colourOf(img, patch.pixels, win).map(Math.round).join(', ');
  }
  return { at: [round(m.x), round(m.y)], r: [round(rx), round(ry)], shine, ink: hex(colourOf(img, blob.pixels, win)), shineColor, pixels: inPicture(inside, win, img) };
}

/**
 * The mouth near `box` (where the LLM saw it): a closed mouth drawn as one dark line, as the fox's
 * mouth is described in public/fox.js: `at`, the line's middle; `halfWidth`, from there to either
 * corner, less the round end of the line; `sag`, how far the middle is below the corners (a smile);
 * `line`, its thickness; and its colour. Null when there's no line about that wide there.
 * @returns {{at: number[], halfWidth: number, sag: number, line: number, ink: string, pixels: number[]}|null}
 */
export function findMouth(img, [l, t, r, b]) {
  const [bw, bh] = [r - l, b - t];
  if (!(bw > 4)) return null;
  const pad = Math.max(bh, 0.3 * bw);
  const win = within(img, [l - 0.5 * bw, t - pad, r + 0.5 * bw, b + pad]);
  const [cx, cy] = [(l + r) / 2 - win.x, (t + b) / 2 - win.y];
  const lines = components(darkIn(img, win), win).filter((c) => {
    const [w, h] = [c.maxX - c.minX + 1, c.maxY - c.minY + 1];
    // As wide as a mouth and much wider than tall, around the middle of the box, and not an outline
    // running out of the window on both sides.
    const across = c.minX <= cx && c.maxX >= cx;
    return w >= 0.4 * bw && w <= 2 * bw && w >= 2 * h && across && !(c.minX === 0 && c.maxX === win.w - 1);
  });
  const blob = lines.sort((a, z) => Math.abs(a.cy - cy) - Math.abs(z.cy - cy))[0];
  if (!blob) return null;
  // The line's middle and thickness in each column.
  const columns = new Map();
  for (const i of blob.pixels) {
    const x = i % win.w;
    const c = columns.get(x) ?? { sum: 0, n: 0 };
    c.sum += Math.floor(i / win.w);
    c.n++;
    columns.set(x, c);
  }
  const median = (list) => list.sort((a, z) => a - z)[Math.floor(list.length / 2)];
  const span = blob.maxX - blob.minX + 1;
  const band = (from, to) => [...columns].filter(([x]) => x >= blob.minX + from * span && x <= blob.minX + to * span).map(([, c]) => c);
  const middle = band(0.4, 0.6);
  const ends = [band(0, 0.05), band(0.95, 1)];
  if (!middle.length || ends.some((e) => !e.length)) return null;
  const centre = median(middle.map((c) => c.sum / c.n));
  const line = Math.max(1.5, median(middle.map((c) => c.n)));
  const corners = ends.map((e) => e.reduce((s, c) => s + c.sum / c.n, 0) / e.length);
  const halfWidth = span / 2 - line / 2;
  if (halfWidth < 5) return null;
  return {
    at: [round(win.x + (blob.minX + blob.maxX) / 2), round(win.y + centre)],
    halfWidth: round(halfWidth),
    sag: round(centre - (corners[0] + corners[1]) / 2),
    line: round(line),
    ink: hex(colourOf(img, blob.pixels, win)),
    pixels: inPicture(blob.pixels, win, img),
  };
}

/**
 * Paints `regions` out of `img` (in place): each {pixels, grow}, pixels of the picture grown by
 * `grow` pixels all round. They're filled in from their edges inwards with the colours around them,
 * then smoothed, which suits the flat colours and soft shading the characters are drawn in.
 */
export function paintOut(img, regions) {
  const { width: w, height: h, data } = img;
  const masked = new Uint8Array(w * h);
  for (const { pixels, grow } of regions) {
    const reach = Math.ceil(grow);
    for (const i of pixels) {
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx * dx + dy * dy > grow * grow) continue;
          const [nx, ny] = [x + dx, y + dy];
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) masked[ny * w + nx] = 1;
        }
      }
    }
  }
  let todo = masked.keys().filter((i) => masked[i]).toArray();
  const all = todo;
  const known = masked.map((m) => 1 - m);
  const around = (i) => {
    const x = i % w;
    const y = (i - x) / w;
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && x + dx >= 0 && y + dy >= 0 && x + dx < w && y + dy < h) out.push(i + dy * w + dx);
    return out;
  };
  // Layer by layer, each pixel takes the average of its neighbours already filled.
  while (todo.length) {
    const filled = [];
    const left = [];
    for (const i of todo) {
      const sum = [0, 0, 0];
      let n = 0;
      for (const j of around(i)) {
        if (!known[j]) continue;
        for (let c = 0; c < 3; c++) sum[c] += data[j * 4 + c];
        n++;
      }
      if (n) filled.push([i, sum.map((s) => Math.round(s / n))]);
      else left.push(i);
    }
    if (!filled.length) break;
    for (const [i, colour] of filled) {
      for (let c = 0; c < 3; c++) data[i * 4 + c] = colour[c];
      known[i] = 1;
    }
    todo = left;
  }
  // Then smoothed, so the layers don't show as streaks.
  for (let pass = 0; pass < 30; pass++) {
    for (const i of all) {
      const sum = [0, 0, 0];
      const near = around(i);
      for (const j of near) for (let c = 0; c < 3; c++) sum[c] += data[j * 4 + c];
      for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(sum[c] / near.length); // rounded: stored, it would be cut down, darker every pass
    }
  }
  return img;
}

/** The picture's background: the average colour of its corners. */
export function backdropOf(img) {
  const size = Math.max(4, Math.round(img.width / 40));
  const sum = [0, 0, 0];
  let n = 0;
  for (const [x0, y0] of [[0, 0], [img.width - size, 0], [0, img.height - size], [img.width - size, img.height - size]]) {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        for (let c = 0; c < 3; c++) sum[c] += img.data[(y * img.width + x) * 4 + c];
        n++;
      }
    }
  }
  return hex(sum.map((s) => s / n));
}

/**
 * Rigs a character: finds its eyes and mouth in `img` near the LLM's boxes (`seen`: leftEye,
 * rightEye, mouth and head, each [left, top, right, bottom]), paints them out of it, and says how to
 * draw it (the rig, as public/fox.js takes it, without its `src`). `picture` is the square around
 * its head that its profile picture shows. Null if its eyes or mouth can't be found, in which case
 * `img` is left as it was.
 * @returns {{rig: object, picture: number[]}|null}
 */
export function rig(img, seen) {
  const eyes = [findEye(img, seen.leftEye), findEye(img, seen.rightEye)];
  const mouth = findMouth(img, seen.mouth);
  if (!eyes[0] || !eyes[1] || !mouth) return null;
  eyes.sort((a, z) => a.at[0] - z.at[0]);
  const between = eyes[1].at[0] - eyes[0].at[0];
  const overlap = between < eyes[0].r[0] + eyes[1].r[0];
  const eyeY = (eyes[0].at[1] + eyes[1].at[1]) / 2;
  if (overlap || mouth.at[1] <= eyeY) return null;
  const { width: w, height: h } = img;
  const faceX = (eyes[0].at[0] + eyes[1].at[0]) / 2;
  const margin = Math.round(MARGIN * w);
  // The head as the LLM saw it, if it holds the face; else guessed from the eyes.
  let [hl, ht, hr, hb] = seen.head ?? [];
  if (!(hl < eyes[0].at[0] && hr > eyes[1].at[0] && ht < eyeY && hb > mouth.at[1])) [hl, ht, hr, hb] = [faceX - 1.6 * between, eyeY - 1.4 * between, faceX + 1.6 * between, mouth.at[1] + 0.9 * between];
  // All of it as drawn, 4:3, which the page's picture of the asker is: as wide as the margins allow,
  // from just above its head, or as near as there's room for.
  const vw = w - 2 * margin;
  const vh = Math.min(h - 2 * margin, Math.round(0.75 * vw));
  const view = [margin, clamp(Math.round(ht - 0.05 * vh), margin, h - margin - vh), vw, vh];
  // Its head and shoulders, square, for the phone's bubble and the profile picture.
  const side = Math.round(clamp(1.12 * Math.max(hr - hl, hb - ht), 3 * between, Math.min(w, h) - 2 * margin));
  const bubble = [clamp(Math.round((hl + hr) / 2 - side / 2), margin, w - margin - side), clamp(Math.round((ht + hb) / 2 - side / 2), margin, h - margin - side), side, side];
  // It sways on a point well below the picture, as the fox does on its feet.
  const pivot = [round(faceX), round(eyeY + 4.1 * between)];
  const shiny = eyes.find((e) => e.shineColor);
  paintOut(img, [
    ...eyes.map((e) => ({ pixels: e.pixels, grow: Math.max(3, 0.25 * Math.min(...e.r)) })),
    { pixels: mouth.pixels, grow: Math.max(3, 1.5 * mouth.line) },
  ]);
  return {
    rig: {
      size: [w, h],
      view,
      bubble,
      pivot,
      backdrop: backdropOf(img),
      ink: eyes[0].ink,
      shineColor: shiny?.shineColor ?? '255, 255, 255',
      eyes: eyes.map(({ at, r, shine }) => ({ at, r, shine })),
      // Its jaw drops about as far as the fox's does for the size of its face, however wide its smile.
      mouth: { at: mouth.at, halfWidth: mouth.halfWidth, sag: mouth.sag, jaw: round(Math.min(0.82 * mouth.halfWidth, 0.15 * between)), line: mouth.line, ink: mouth.ink },
    },
    picture: bubble,
  };
}

// ---------- reading and writing pictures, with ffmpeg ----------

function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'], timeout: FFMPEG_TIMEOUT });
    const out = [];
    let err = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed (${code}): ${err.trim().slice(-500)}`))));
    child.stdin.on('error', () => {}); // it may exit before reading all of it; close says why
    child.stdin.end(input);
  });
}

/** A PNG (as the image model draws it) as a picture. */
export async function readPng(png) {
  if (png.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) throw new Error('not a PNG');
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  const data = await ffmpeg(['-f', 'png_pipe', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], png);
  if (data.length !== width * height * 4) throw new Error(`ffmpeg read ${data.length} bytes of a ${width}x${height} PNG`);
  return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

/** A picture as a WebP: the `crop` of it ([x, y, w, h]) if given, scaled to `size` pixels square if given. */
export function toWebp(img, { crop = null, size = null } = {}) {
  const filters = [crop && `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]}`, size && `scale=${size}:${size}:flags=lanczos`].filter(Boolean);
  return ffmpeg(
    ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${img.width}x${img.height}`, '-i', 'pipe:0', ...(filters.length ? ['-vf', filters.join(',')] : []), '-frames:v', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libwebp', '-quality', '90', '-f', 'webp', 'pipe:1'],
    Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length),
  );
}
