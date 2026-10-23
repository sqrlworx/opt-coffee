// The fox, and askers' own characters, shared by the page (app.js) and the mobile app (mobile/),
// which both draw them in their players.

// The fox, which says a question nobody asked on camera, unless the asker made a character of their
// own (src/avatar/), which is drawn the same way from a rig like this one. fox.webp is the fox with
// its eyes and mouth painted out; they're drawn here instead, so it can blink and talk. Coordinates
// are in that picture's pixels.
export const FOX = {
  src: '/fox.webp',
  view: [75, 90, 627, 470], // the part shown (x, y, width, height): all of it as drawn; the rest leaves room to sway
  bubble: [96, 12, 588, 588], // the part the phone's round bubble shows: its head and shoulders, the circle keeping its ears in and the picture's edges out as it sways
  pivot: [389.5, 1125], // its feet, below the picture: it sways and bounces on them
  backdrop: '#f9f9f9', // its picture's background, which shows around it in the phone's bubble
  ink: '#100d0b', // its eyes, and its mouth's line unless the mouth has an ink of its own
  shineColor: '228, 228, 225',
  // shine: the highlight's centre, radii and angle, or null for eyes without one
  eyes: [
    { at: [299.1, 383.7], r: [18.3, 18.8], shine: [309.4, 375, 4.3, 2.7, 0.82] },
    { at: [479.8, 383.6], r: [18.4, 18.6], shine: [487.6, 374.3, 5.4, 3.2, 0.78] },
  ],
  mouth: { at: [390.6, 425.4], halfWidth: 25.5, sag: 10, jaw: 21, line: 5 }, // at: the bottom of its smile
};

// The character `rig` (FOX, or an asker's) on `canvas`, the `part` of its picture shown: 'view',
// all of it, or 'bubble', its head. `draw(pose, blink, t)` shows it with a pose from a question's
// lip sync, [open, width, energy] (see src/speech/lipsync.py), its eyes `blink` (0-1) shut, `t`
// seconds into the question, which sets its idle sway. Its picture starts loading right away.
export function character(canvas, rig = FOX, part = 'view') {
  const ctx = canvas.getContext('2d');
  const image = new Image();
  const view = rig[part];
  let last = null;
  image.onload = () => last && draw(...last);
  image.src = rig.src;

  function eye({ at: [x, y], r: [rx, ry], shine }, blink) {
    const [sx, sy, srx, sry, angle] = shine ?? [];
    // It blinks by squashing, as the lid comes down.
    const squash = 1 - 0.9 * blink;
    ctx.save();
    ctx.translate(x, y + 0.45 * ry * (1 - squash));
    ctx.scale(1, squash);
    ctx.fillStyle = rig.ink;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, 2 * Math.PI);
    ctx.fill();
    if (shine && blink < 0.6) {
      ctx.globalAlpha = 1 - blink / 0.6;
      ctx.translate(sx - x, sy - y);
      ctx.rotate(angle);
      ctx.scale(srx, sry);
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      glow.addColorStop(0, `rgba(${rig.shineColor}, 0.95)`);
      glow.addColorStop(0.6, `rgba(${rig.shineColor}, 0.9)`);
      glow.addColorStop(1, `rgba(${rig.shineColor}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  function mouth(open, width) {
    const { at: [mx, my], halfWidth, sag, jaw, line, ink = rig.ink } = rig.mouth;
    const hw = halfWidth * width;
    const depth = jaw * open;
    const top = my - 0.12 * depth; // the upper lip lifts a little
    const bottom = my + depth;
    // Narrow shapes (oh, oo) are round, with the corners halfway down the opening; wide ones keep
    // the smile, flattening as the jaw drops.
    const round = Math.min(1, Math.max(0, (0.85 - width) / 0.4)) * Math.min(1, 4 * open);
    const smile = my - sag * width * (1 - 0.5 * open);
    const corner = smile + ((top + bottom) / 2 - smile) * round;
    // A lip from one corner to the other through `y` in the middle: a parabola, or boxier with `box`.
    const lip = (path, from, to, y, box) => {
      const reach = ((to - from) * (1 - box)) / 3;
      const control = (4 * y - corner) / 3;
      path.bezierCurveTo(from + reach, control, to - reach, control, to, corner);
    };
    const path = new Path2D();
    path.moveTo(mx - hw, corner);
    lip(path, mx - hw, mx + hw, top, round);
    ctx.lineWidth = line;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = ink;
    if (depth < 0.5) return ctx.stroke(path);
    lip(path, mx + hw, mx - hw, bottom, 0.35 + 0.65 * round);
    path.closePath();
    ctx.save();
    ctx.clip(path);
    const inside = ctx.createLinearGradient(0, top, 0, bottom);
    inside.addColorStop(0, '#2a0f10');
    inside.addColorStop(1, '#5e2328');
    ctx.fillStyle = inside;
    ctx.fillRect(mx - hw - line, Math.min(corner, top) - line, 2 * (hw + line), bottom - Math.min(corner, top) + 2 * line);
    ctx.fillStyle = '#d9737f'; // the tongue, behind the lower lip
    ctx.beginPath();
    ctx.ellipse(mx, bottom, 0.55 * hw, Math.min(0.42 * depth, 0.3 * halfWidth), 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
    ctx.stroke(path);
  }

  function draw(pose, blink, t) {
    last = [pose, blink, t];
    const [vx, vy, vw, vh] = view;
    const w = Math.round(canvas.clientWidth * devicePixelRatio);
    if (!w || !image.naturalWidth) return;
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = Math.round((w * vh) / vw);
    }
    const [open, width, energy] = pose;
    const scale = w / vw;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height); // another character may have been drawn on it
    ctx.setTransform(scale, 0, 0, scale, -vx * scale, -vy * scale);
    // A slow sway and breathing, and it rises a little on the louder parts, by as much in any view.
    const wave = (period, phase = 0) => Math.sin((2 * Math.PI * t) / period + phase);
    const [px, py] = rig.pivot;
    const breathe = 0.005 * wave(3.4);
    ctx.translate(px, py - rig.view[3] * (0.003 * wave(3.7, 0.9) + 0.014 * energy));
    ctx.rotate(((wave(5.3, 0.4) + 0.4 * wave(2.9, 1.7)) * Math.PI) / 180);
    ctx.scale(1 + breathe - 0.006 * energy, 1 + breathe + 0.012 * energy);
    ctx.translate(-px, -py);
    ctx.imageSmoothingQuality = 'high'; // it's drawn a few times smaller than it is, and fur shimmers otherwise
    ctx.drawImage(image, 0, 0);
    for (const e of rig.eyes) eye(e, blink);
    mouth(open, width);
  }

  return { el: canvas, draw };
}

// How far shut a character's eyes are `t` seconds into a question: it blinks every 2-5 seconds,
// at random but the same each time the question with id `seed` plays.
export function blinkAt(seed, t) {
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let x = Math.imul(state ^ (state >>> 15), 1 | state);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32;
  };
  for (let start = 0.6 + 1.2 * random(); start <= t; start += 2.2 + 2.8 * random()) {
    const since = t - start;
    if (since < 0.07) return since / 0.07;
    if (since < 0.1) return 1;
    if (since < 0.23) return 1 - (since - 0.1) / 0.13;
  }
  return 0;
}

// A pose `t` seconds into talking, as from a question's lip sync, for showing a character off
// without one: syllables about five a second, in phrases with a pause between them.
export function babble(t) {
  const open = t % 3.2 < 2.4 ? Math.max(0, Math.sin(2 * Math.PI * 4.6 * t)) * (0.55 + 0.35 * Math.sin(1.7 * t)) : 0;
  return [open, 0.85 + 0.3 * Math.sin(2.9 * t), 0.6 * open];
}
