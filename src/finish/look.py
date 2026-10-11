"""The portrait look, frame by frame.

The person is cut out with Robust Video Matting and lit like a portrait: more light on the side
of the face that's already lit, falling off down the body, with a little local contrast. The room
behind is darkened, cooled, desaturated and thrown out of focus. A filmic curve, a vignette and a
light split tone finish it.

Anything that could flicker is fixed per take (white balance, exposure, background level, light
direction) or smoothed over time (the face's position), so frames differ only where the picture
does.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

GAMMA = 2.4  # BT.1886: code values as a screen shows them, to linear light
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
TO_LINEAR = (np.arange(256, dtype=np.float32) / 255) ** GAMMA

# The look. Light levels are linear.
FACE_LEVEL = 0.20  # the face's mid-tones; after the curve, about 60% on screen
BG_RATIO = 0.30  # the room relative to the face: under two stops darker
BG_BLUR = 0.008  # defocus of the room (sigma), as a fraction of the frame's long side
BG_SATURATION = 0.5
BG_TINT = np.array([0.97, 1.0, 1.04], np.float32)
BG_POOL_EV = 0.4  # a little more light behind the person...
BG_EDGE_EV = 0.6  # ...and less towards the edges of the frame
KEY_EV = 0.7  # the lit side of the face over the far side
BODY_FALLOFF_EV = 0.9  # the chest, below the chin
CLARITY = 0.3  # local contrast on the person
SKIN = np.array([2.2, 0.62], np.float32)  # pleasing skin as (r/g, b/g), in linear light
WB_STRENGTH = 0.35  # how far skin is moved towards it
VIGNETTE = 0.25
SHADOW_TINT = np.array([-0.006, 0.0, 0.008], np.float32)  # teal shadows
HIGHLIGHT_TINT = np.array([0.008, 0.002, -0.008], np.float32)  # warm highlights
SATURATION = 1.04


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def _blur(x: np.ndarray, sigma: float) -> np.ndarray:
    return cv2.GaussianBlur(x, (0, 0), sigma, borderType=cv2.BORDER_REFLECT)


def _aces(x: np.ndarray) -> np.ndarray:
    """Narkowicz's fit of the ACES filmic curve: a gentle toe and a long highlight shoulder."""
    return np.clip((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1)


class Matter:
    """Robust Video Matting: the person's alpha matte, frame by frame. It's recurrent, so the matte
    settles over the first few frames and then stays stable."""

    def __init__(self, path, threads: int = 1):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        self._session = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self) -> None:
        self._state = [np.zeros((1, 1, 1, 1), np.float32)] * 4

    def __call__(self, rgb: np.ndarray) -> np.ndarray:
        h, w = rgb.shape[:2]
        # The network sees about 320 px on the long side; its refiner brings the edges back to full size.
        ratio = np.array([min(1.0, 320 / max(h, w))], np.float32)
        src = (rgb.astype(np.float32) / 255).transpose(2, 0, 1)[None]
        r1, r2, r3, r4 = self._state
        _, pha, *self._state = self._session.run(None, {"src": src, "r1i": r1, "r2i": r2, "r3i": r3, "r4i": r4, "downsample_ratio": ratio})
        return pha[0, 0]


class FaceFinder:
    """YuNet: the largest face in a frame, as (x, y, w, h)."""

    def __init__(self, path, size: tuple[int, int]):
        self._detector = cv2.FaceDetectorYN.create(str(path), "", size, 0.6, 0.3, 20)

    def __call__(self, rgb: np.ndarray) -> tuple[float, float, float, float] | None:
        _, faces = self._detector.detect(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        if faces is None or not len(faces):
            return None
        best = max(faces, key=lambda f: f[2] * f[3])
        return tuple(float(v) for v in best[:4])


def face_track(found: dict[int, tuple | None], frames: int, fps: float) -> np.ndarray | None:
    """Per-frame face boxes from detections on some of the frames. Gaps are filled in and the track
    is smoothed over about a third of a second, so the light stays put while the head moves.
    None when there's no face for most of the take."""
    hits = sorted(i for i, box in found.items() if box is not None)
    if len(hits) < max(3, 0.3 * len(found)):
        return None
    boxes = np.array([found[i] for i in hits], np.float64)
    # A stray detection (a face on a poster, a hand) jumps away from its neighbours.
    centre = boxes[:, :2] + boxes[:, 2:] / 2
    k = 9
    pad = np.pad(centre, ((k // 2, k // 2), (0, 0)), mode="edge")
    median = np.median(np.lib.stride_tricks.sliding_window_view(pad, k, axis=0), axis=2)
    keep = np.linalg.norm(centre - median, axis=1) < 0.5 * np.median(boxes[:, 2])
    hits, boxes = np.array(hits)[keep], boxes[keep]
    t = np.arange(frames)
    track = np.stack([np.interp(t, hits, boxes[:, j]) for j in range(4)], axis=1)
    sigma = fps / 3
    radius = int(3 * sigma)
    kernel = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(track, ((radius, radius), (0, 0)), mode="edge")
    return np.stack([np.convolve(padded[:, j], kernel, mode="valid") for j in range(4)], axis=1).astype(np.float32)


@dataclass
class Grade:
    """A take's settings, measured once so nothing drifts from frame to frame."""

    wb: tuple[float, float, float] = (1.0, 1.0, 1.0)
    exposure: float = 1.0
    bg_gain: float = 1.0
    key_side: float = 0.0  # +1: the face is lit from the right of the frame, -1: from the left, 0: no face
    person: bool = False  # a person to separate from the room


def _skin(lin: np.ndarray, alpha: np.ndarray, face) -> tuple[np.ndarray, float, float] | None:
    """Median skin colour in the middle of the face (cheeks, nose, under the eyes), and the median
    level of its left and right halves."""
    x, y, w, h = face
    rows, cols = alpha.shape
    x0, x1 = int(max(0, x + 0.22 * w)), int(min(cols, x + 0.78 * w))
    y0, y1 = int(max(0, y + 0.30 * h)), int(min(rows, y + 0.72 * h))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None
    region, a = lin[y0:y1, x0:x1], alpha[y0:y1, x0:x1]
    level = region @ LUMA
    lo, hi = np.percentile(level, [25, 97])  # leave out eyes, brows, nostrils and shine
    ok = (a > 0.9) & (level > lo) & (level < hi)
    if ok.sum() < 50:
        return None
    mid = (x1 - x0) // 2
    left, right = level[:, :mid][ok[:, :mid]], level[:, mid:][ok[:, mid:]]
    if not len(left) or not len(right):
        return None
    return np.median(region[ok], axis=0), float(np.median(left)), float(np.median(right))


def measure(samples: list[tuple[np.ndarray, np.ndarray, tuple | None]]) -> tuple[Grade, dict]:
    """The grade for a take, from (rgb, alpha, face) samples spread across it."""
    cover, room, skins, sides = [], [], [], []
    for rgb, alpha, face in samples:
        lin = TO_LINEAR[rgb]
        cover.append(float((alpha > 0.5).mean()))
        if (alpha < 0.05).mean() > 0.05:
            room.append(float(np.median((lin @ LUMA)[alpha < 0.05])))
        skin = _skin(lin, alpha, face) if face is not None else None
        if skin is not None:
            skins.append(skin[0])
            sides.append((skin[2] - skin[1]) / max(skin[2] + skin[1], 1e-6))
    facts = {"person_cover": round(float(np.median(cover)), 3) if cover else 0.0, "faces": len(skins)}
    grade = Grade(person=bool(cover) and float(np.median(cover)) > 0.03)
    if not skins:
        return grade, facts
    skin = np.median(np.array(skins), axis=0)
    face_level = float(skin @ LUMA)
    # White balance: part of the way from this skin to a pleasing one, never more than 15%.
    gains = (SKIN / np.array([skin[0] / skin[1], skin[2] / skin[1]], np.float32)) ** WB_STRENGTH
    wb = np.clip(np.array([gains[0], 1.0, gains[1]], np.float32), 0.85, 1.15)
    wb /= float(wb @ LUMA)
    grade.wb = tuple(round(float(v), 4) for v in wb)
    grade.exposure = round(float(np.clip(FACE_LEVEL / face_level, 0.6, 2.5)), 4)
    if grade.person and room:
        grade.bg_gain = round(float(np.clip(face_level * BG_RATIO / max(np.median(room), 1e-4), 0.08, 1.0)), 4)
    side = float(np.median(sides))
    grade.key_side = 1.0 if side >= 0 else -1.0
    facts.update(face_level=round(face_level, 4), room_level=round(float(np.median(room)), 4) if room else None, face_left_right=round(side, 3))
    return grade, facts


class Look:
    """Renders the frames of one take with its grade."""

    def __init__(self, width: int, height: int, grade: Grade):
        self.w, self.h, self.g = width, height, grade
        self.wb = np.array(grade.wb, np.float32)
        side = max(width, height)
        self.edge_sigma = 0.0025 * side
        # Light maps are smooth, so they're worked out at a quarter of the size.
        self.qw, self.qh = max(8, width // 4), max(8, height // 4)
        qy, qx = np.mgrid[0 : self.qh, 0 : self.qw].astype(np.float32)
        self.qx, self.qy = (qx + 0.5) * width / self.qw, (qy + 0.5) * height / self.qh
        yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
        r2 = ((xx - width / 2) / (width / 2)) ** 2 + ((yy - height / 2) / (height / 2)) ** 2
        self.vignette = (1 - VIGNETTE * _smoothstep(0.3, 2.0, r2)).astype(np.float32)

    def _full(self, quarter: np.ndarray) -> np.ndarray:
        return cv2.resize(quarter.astype(np.float32), (self.w, self.h), interpolation=cv2.INTER_LINEAR)

    def _light(self, face) -> np.ndarray:
        """A soft key light on an ellipsoid head, from the side the face is already lit from, as a gain."""
        x, y, w, h = face
        cx, cy = x + w / 2, y + 0.48 * h
        u, v = (self.qx - cx) / (0.75 * w), (self.qy - cy) / (0.70 * h)
        r = np.sqrt(u * u + v * v)
        nz = np.sqrt(np.clip(1 - r * r, 0, 1))
        key = np.array([0.55 * self.g.key_side, -0.45, 0.70], np.float32)
        key /= np.linalg.norm(key)
        lambert = np.clip(u * key[0] + v * key[1] + nz * key[2], 0, 1)
        inside = _smoothstep(1.15, 0.85, r)
        ev = KEY_EV * (lambert - key[2]) * inside  # the middle of the face keeps its level
        chin = y + h
        ev -= BODY_FALLOFF_EV * _smoothstep(chin - 0.05 * h, chin + 0.6 * h, self.qy) * (1 - inside)
        return self._full(np.exp2(_blur(ev.astype(np.float32), 1.5)))

    def _pool(self, face) -> np.ndarray:
        """The room: a little brighter behind the person, darker towards the edges of the frame."""
        if face is not None:
            cx, cy = face[0] + face[2] / 2, face[1] + face[3] / 2 - 0.1 * self.h
        else:
            cx, cy = self.w / 2, 0.35 * self.h
        d = np.sqrt(((self.qx - cx) / (0.55 * self.w)) ** 2 + ((self.qy - cy) / (0.6 * self.h)) ** 2)
        return self._full(np.exp2(BG_POOL_EV * (1 - _smoothstep(0, 1.2, d)) - BG_EDGE_EV * _smoothstep(0.5, 1.4, d)))

    def _background(self, lin: np.ndarray, alpha: np.ndarray, face) -> np.ndarray:
        # Defocus by averaging only the room's own pixels (normalised convolution), so the person
        # doesn't bleed into it. Where the person covers everything nearby, a wider average fills in.
        weight = (1 - alpha) ** 2
        hw, hh = self.w // 2, self.h // 2
        half = cv2.resize(lin * weight[..., None], (hw, hh), interpolation=cv2.INTER_AREA)
        half_w = cv2.resize(weight, (hw, hh), interpolation=cv2.INTER_AREA)
        sigma = BG_BLUR * max(self.w, self.h) / 2
        num, den = _blur(half, sigma), _blur(half_w, sigma)
        ew, eh = max(4, self.w // 8), max(4, self.h // 8)
        wide = cv2.resize(_blur(cv2.resize(half, (ew, eh), interpolation=cv2.INTER_AREA), sigma), (hw, hh))
        wide_w = cv2.resize(_blur(cv2.resize(half_w, (ew, eh), interpolation=cv2.INTER_AREA), sigma), (hw, hh))
        near = num / np.maximum(den, 1e-4)[..., None]
        far = wide / np.maximum(wide_w, 1e-4)[..., None]
        mix = _smoothstep(0.05, 0.25, den)[..., None]
        bg = cv2.resize(far + (near - far) * mix, (self.w, self.h), interpolation=cv2.INTER_LINEAR)
        bg *= self.g.bg_gain
        level = (bg @ LUMA)[..., None]
        bg = level + (bg - level) * BG_SATURATION
        bg *= BG_TINT * self._pool(face)[..., None]
        return bg

    def _clarity(self, subject: np.ndarray, a: np.ndarray) -> np.ndarray:
        """Local contrast on the person: log luminance against its own blurred base, at half size."""
        logy = np.log2(subject @ LUMA + 1e-4)
        hw, hh = self.w // 2, self.h // 2
        sigma = 0.006 * max(self.w, self.h)
        wl = cv2.resize(logy * a, (hw, hh), interpolation=cv2.INTER_AREA)
        ws = cv2.resize(a, (hw, hh), interpolation=cv2.INTER_AREA)
        base = cv2.resize(_blur(wl, sigma) / np.maximum(_blur(ws, sigma), 1e-3), (self.w, self.h), interpolation=cv2.INTER_LINEAR)
        detail = np.clip(logy - base, -1.5, 1.5)
        return subject * np.exp2(CLARITY * detail * a)[..., None]

    def __call__(self, rgb: np.ndarray, alpha: np.ndarray, face, seed: int) -> np.ndarray:
        """8-bit RGB in, 8-bit RGB out (dithered)."""
        g = self.g
        lin = TO_LINEAR[rgb]
        if g.person:
            # Edge pixels mix the person with the old room: take their colour from the person's
            # own pixels nearby instead, then pull the matte in a little.
            core = (alpha > 0.97).astype(np.float32)
            pulled = _blur(lin * core[..., None], self.edge_sigma) / np.maximum(_blur(core, self.edge_sigma), 1e-4)[..., None]
            edge = _smoothstep(0.995, 0.5, alpha)[..., None]
            subject = lin + (pulled - lin) * edge
            a = _smoothstep(0.35, 0.98, alpha)
        else:
            subject, a = lin, None
        subject *= self.wb
        if face is not None and g.key_side:
            subject *= self._light(face)[..., None]
        if a is not None:
            subject = self._clarity(subject, a)
            bg = self._background(lin, alpha, face)
            out = bg + (subject - bg) * a[..., None]
        else:
            out = subject
        return self._finish(out, seed)

    def _finish(self, out: np.ndarray, seed: int) -> np.ndarray:
        g = self.g
        # Exposure, then the filmic curve on luminance only, so hues stay put.
        y = (out @ LUMA) * g.exposure
        curved = _aces(y)
        out = out * (g.exposure * curved / np.maximum(y, 1e-6))[..., None]
        hl = _smoothstep(0.6, 1.0, curved)[..., None]  # highlights desaturate, as on film
        out += (curved[..., None] - out) * hl
        out *= self.vignette[..., None]
        disp = cv2.pow(np.clip(out, 0, 1), 1 / GAMMA)
        level = (disp @ LUMA)[..., None]
        disp += (1 - _smoothstep(0.0, 0.45, level)) * SHADOW_TINT + _smoothstep(0.55, 1.0, level) * HIGHLIGHT_TINT
        level = (disp @ LUMA)[..., None]
        disp = level + (disp - level) * SATURATION
        # Triangular dither on the way to 8 bits, so the smooth room doesn't band.
        rng = np.random.default_rng(seed)
        noise = rng.random(disp.shape, dtype=np.float32) - rng.random(disp.shape, dtype=np.float32)
        return np.clip(disp * 255 + noise + 0.5, 0, 255).astype(np.uint8)
