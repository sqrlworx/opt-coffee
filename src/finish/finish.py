#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.12"
# dependencies = [
#     "numpy<2",  # deepfilternet 0.5.6 predates numpy 2
#     "opencv-python-headless>=4.9,<4.11",
#     "onnxruntime>=1.17,<1.20",
#     "torch==2.2.2",  # deepfilternet 0.5.6 needs torchaudio's older backend API
#     "torchaudio==2.2.2",
#     "deepfilternet==0.5.6",
#     "transformers>=4.40,<5",  # Sidon's audio features (w2v-BERT 2.0's feature extractor)
#     "huggingface_hub",
# ]
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# torchaudio = { index = "pytorch-cpu" }
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""Finishing for the answer videos before they're joined: makes each take look and sound produced.

The server (src/finish/index.js) runs this once per office hour with a job file:

    uv run finish.py job.json

    {"takes": [{"input": "media/a.mp4", "output": "/tmp/x/0.mp4", "answer_start": 4.95,
                "cues": [[start, end, "text"], ...] or null, "words": [[start, end, " word"], ...] or null,
                "cutaway": {"input": "media/b.mp4", "filter": "..."} or null}],
     "voice": "studio" or "natural", "workers": 0}

Every take becomes a 1920x1080, 30 fps H.264/AAC part, so the parts join without re-encoding:
- picture (look.py): the person cut out and lit like a portrait against a darker, defocused room,
  a filmic grade, then a careful upscale, sharpening and a fine grain;
- sound (sound.py): the voice restored to studio quality (or, as "natural", only cleaned up),
  then a broadcast voice chain, with question and answer each at -16 LUFS;
- captions (captions.py), when the take has a transcript: a few words at a time, a colour per
  speaker, louder words bigger and key words heavier or in italics;
- b-roll, when the take has a cutaway: its clip, and the ffmpeg filter graph that cuts away to it
  (made by src/video.js), from [pic], the finished picture, and [2:v], the clip, to [cut]. It goes
  under the grain and the captions.

The takes are cut into pieces of a few seconds that render in parallel. Logs go to stderr; the
last line on stdout is a JSON report. Exits non-zero on failure.
"""

from __future__ import annotations

import itertools
import json
import multiprocessing
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import assets
import captions
from look import FaceFinder, Grade, Look, Matter, face_track, measure

FPS = 30
SR = 48000
OUT_W, OUT_H = 1920, 1080
PIECE = 120  # frames rendered per task
WARMUP = 24  # frames the matte settles over before a piece starts
SAMPLES = 16  # frames measured for a take's grade
CRF = 20


def log(msg: str) -> None:
    print(f"[finish] {msg}", file=sys.stderr, flush=True)


def ffmpeg(*args: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(["ffmpeg", "-nostdin", "-y", "-hide_banner", "-loglevel", "error", *args], check=True, **kw)


def _escape(path) -> str:
    """A path as a filter option value."""
    return "'" + str(path).replace("\\", "\\\\").replace("'", "'\\''").replace(":", "\\:") + "'"


def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height,color_space,color_range:stream_side_data=rotation", "-of", "json", path],
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    streams = json.loads(out)["streams"]
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if not video:
        raise RuntimeError(f"{path} has no video")
    w, h = video["width"], video["height"]
    rotation = next((abs(int(d.get("rotation", 0))) for d in video.get("side_data_list", [])), 0)
    if rotation in (90, 270):  # decoding turns it upright
        w, h = h, w
    space = video.get("color_space")
    matrix = "bt709" if space in ("bt709",) else "bt601" if space in ("bt470bg", "smpte170m") else ("bt709" if h >= 720 else "bt601")
    return {"width": w, "height": h, "matrix": matrix, "range": "pc" if video.get("color_range") == "pc" else "tv", "audio": any(s.get("codec_type") == "audio" for s in streams)}


def working_size(w: int, h: int) -> tuple[int, int]:
    """The take's size, shrunk to fit the output if it's bigger (never enlarged), in multiples of 4."""
    s = min(1.0, OUT_W / w, OUT_H / h)
    return max(16, int(w * s) // 4 * 4), max(16, int(h * s) // 4 * 4)


def frames_in(path: Path) -> int:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", str(path)],
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    return int(out.strip().split(",")[0])


def read_frames(path: Path, size: tuple[int, int], first: int = 0, count: int | None = None):
    """RGB frames of a conformed take (constant frame rate, BT.709), from frame `first` on."""
    w, h = size
    args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]
    if first:
        args += ["-ss", f"{(first - 0.5) / FPS:.6f}"]  # halfway to the frame before, so it's exact
    args += ["-i", str(path)]
    if count is not None:
        args += ["-frames:v", str(count)]
    args += ["-vf", f"scale={w}:{h}:flags=area:in_color_matrix=bt709:in_range=tv,format=rgb24", "-f", "rawvideo", "-"]
    proc = subprocess.Popen(args, stdout=subprocess.PIPE)
    size_bytes = w * h * 3
    try:
        while True:
            buf = proc.stdout.read(size_bytes)
            if len(buf) < size_bytes:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        proc.wait()


# ---------- work done in the pool's processes ----------

_worker: dict = {}


def _init(rvm: str, yunet: str) -> None:
    import cv2

    cv2.setNumThreads(1)
    _worker["matter"] = Matter(rvm, threads=1)
    _worker["yunet"] = yunet


def _analyse(index: int, take: dict, tmp: str) -> dict:
    """Conforms a take to a constant frame rate, tracks the face and measures the grade."""
    started = time.time()
    info = probe(take["input"])
    size = working_size(info["width"], info["height"])
    conformed = Path(tmp) / f"take{index}.mkv"
    # Decode once into exact frames at 30 fps, calming the camera's compression shimmer, and
    # convert through RGB into one known colour space.
    ffmpeg(
        "-i", take["input"], "-map", "0:v:0",
        "-vf", f"fps={FPS}:start_time=0,hqdn3d=2:1.5:5:4,scale={size[0]}:{size[1]}:flags=lanczos:in_color_matrix={info['matrix']}:in_range={info['range']},format=rgb24,"
        "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8", "-g", str(FPS), "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        str(conformed),
    )  # fmt: skip
    frames = frames_in(conformed)
    # Faces on every other frame, at a small size; the grade from frames spread over the take.
    small = (640, max(16, round(640 * size[1] / size[0] / 2) * 2))
    finder = FaceFinder(_worker["yunet"], small)
    matter = _worker["matter"]
    sample_at = set(np.linspace(0, frames - 1, min(SAMPLES, frames)).astype(int).tolist())
    found, samples = {}, []
    for i, rgb in enumerate(read_frames(conformed, small)):
        if i % 2 == 0 or i in sample_at:
            found[i] = finder(rgb)
        if i in sample_at:
            matter.reset()
            samples.append((rgb, matter(rgb), found[i]))
    track = face_track(found, frames, FPS)
    if track is not None:
        track *= np.array([size[0] / small[0], size[1] / small[1]] * 2, np.float32)
    grade, facts = measure(samples)
    log(f"take {index + 1}: {frames} frames at {size[0]}x{size[1]}, face {'tracked' if track is not None else 'not found'}, {time.time() - started:.1f}s")
    return {"conformed": str(conformed), "frames": frames, "size": size, "track": track, "grade": asdict(grade), "facts": facts, "audio": info["audio"]}


def _render(task: dict) -> str:
    """Renders frames [start, start + count) of a take into a near-lossless piece."""
    w, h = task["size"]
    grade = Grade(**task["grade"])
    look = Look(w, h, grade)
    matter = _worker["matter"]
    matter.reset()
    start, count, track = task["start"], task["count"], task["track"]
    first = max(0, start - WARMUP)
    enc = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
         "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv444p", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "6", "-threads", "2",
         "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", task["out"]],
        stdin=subprocess.PIPE,
    )  # fmt: skip
    frames = read_frames(Path(task["conformed"]), (w, h), first, start + count - first)
    head = []
    if grade.person and start == 0:
        # Nothing comes before the first piece, so the matte settles on its opening frames, backwards.
        head = [next(frames, None) for _ in range(min(WARMUP, count))]
        head = [f for f in head if f is not None]
        for rgb in reversed(head):
            matter(rgb)
    written = 0
    for i, rgb in enumerate(itertools.chain(head, frames)):
        index = first + i
        alpha = matter(rgb) if grade.person else None
        if index < start:
            continue
        face = track[index - start] if track is not None else None
        enc.stdin.write(look(rgb, alpha, face, seed=task["seed"] + index).tobytes())
        written += 1
    enc.stdin.close()
    if enc.wait() != 0 or written != count:
        raise RuntimeError(f"piece at frame {start} of {task['out']}: wrote {written} of {count} frames")
    return task["out"]


# ---------- the main process ----------


def read_audio(path: str, has_audio: bool, samples: int) -> np.ndarray:
    if not has_audio:
        return np.zeros(samples, np.float32)
    out = ffmpeg("-i", path, "-map", "0:a:0", "-af", f"aresample={SR}:async=1:first_pts=0", "-ac", "1", "-f", "f32le", "-", capture_output=True).stdout
    x = np.frombuffer(out, np.float32)
    return np.pad(x, (0, max(0, samples - len(x))))[:samples].copy()


def fit_filter(size: tuple[int, int]) -> str:
    """Scales the picture to the output. A take of another shape sits over a blurred, darker copy of itself."""
    w, h = size
    if abs(w / h - OUT_W / OUT_H) < 0.01:
        return f"scale={OUT_W}:{OUT_H}:flags=lanczos+accurate_rnd+full_chroma_int"
    return (
        f"split=2[fill][fg];[fill]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=increase,crop={OUT_W}:{OUT_H},gblur=sigma=40,"
        f"eq=brightness=-0.06:saturation=0.7[bg];[fg]scale={OUT_W}:{OUT_H}:force_original_aspect_ratio=decrease:flags=lanczos+accurate_rnd+full_chroma_int[top];"
        "[bg][top]overlay=(W-w)/2:(H-h)/2"
    )


def placement(size: tuple[int, int]) -> tuple[float, float, float]:
    """Scale and offset from working pixels to output pixels."""
    w, h = size
    s = min(OUT_W / w, OUT_H / h)
    return s, (OUT_W - w * s) / 2, (OUT_H - h * s) / 2


def encode(index: int, take: dict, info: dict, pieces: list[str], audio: Path, ass: Path | None, fonts: Path, tmp: Path) -> None:
    listing = tmp / f"take{index}.txt"
    listing.write_text("".join(f"file '{p}'\n" for p in pieces))
    picture = f"[0:v]setpts=N/{FPS}/TB,{fit_filter(info['size'])},cas=strength=0.4:planes=1"  # sharpen the detail the upscale softened (luma only)
    finishing = [
        "noise=c0s=3:c0f=t",  # a fine moving grain, as from a camera sensor
        *([f"ass={_escape(ass)}:fontsdir={_escape(fonts)}"] if ass else []),
        "format=yuv420p",
    ]
    cutaway = take.get("cutaway")
    if cutaway:
        graph = f"{picture}[pic];{cutaway['filter']};[cut]{','.join(finishing)}[v]"
    else:
        graph = f"{picture},{','.join(finishing)}[v]"
    ffmpeg(
        "-f", "concat", "-safe", "0", "-i", str(listing),
        "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", str(audio),
        *(["-i", cutaway["input"]] if cutaway else []),
        "-filter_complex", graph, "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(CRF), "-profile:v", "high", "-level:v", "4.1", "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "192k", "-ar", str(SR), "-ac", "2", take["output"],
    )  # fmt: skip


def main() -> None:
    import sound

    started = time.time()
    job = json.loads(Path(sys.argv[1]).read_text())
    takes = job["takes"]
    voice = job.get("voice") or "studio"
    workers = int(job.get("workers") or 0) or max(1, min(48, (os.cpu_count() or 2) // 2))
    rvm = assets.model("rvm_mobilenetv3_fp32.onnx")
    yunet = assets.model("face_detection_yunet_2023mar.onnx")
    fonts = assets.fonts_dir()
    report = {"takes": [], "workers": workers}
    context = multiprocessing.get_context("spawn")  # the main process has torch loaded; don't fork it
    with (
        tempfile.TemporaryDirectory(prefix="forum_finish_") as tmpdir,
        ProcessPoolExecutor(workers, mp_context=context, initializer=_init, initargs=(str(rvm), str(yunet))) as pool,
        ThreadPoolExecutor(3) as encoders,
    ):
        tmp = Path(tmpdir)
        analyses = [pool.submit(_analyse, i, take, tmpdir) for i, take in enumerate(takes)]
        pending = []
        for i, take in enumerate(takes):
            info = analyses[i].result()
            frames, size, track = info["frames"], info["size"], info["track"]
            pieces = []
            for start in range(0, frames, PIECE):
                count = min(PIECE, frames - start)
                out = tmp / f"take{i}_{start:07d}.mkv"
                task = {"conformed": info["conformed"], "size": size, "grade": info["grade"], "start": start, "count": count, "out": str(out), "seed": i * 10_000_000}
                task["track"] = None if track is None else track[start : start + count]
                pieces.append(pool.submit(_render, task))
            # Sound and captions here while the pieces render.
            samples = frames * SR // FPS
            dialogue, clean, audio_report = sound.finish(read_audio(take["input"], info["audio"], samples), take.get("answer_start"), voice)
            audio_path = tmp / f"take{i}.f32"
            np.ascontiguousarray(dialogue, np.float32).tofile(audio_path)
            ass, phrases = None, 0
            if take.get("cues"):
                built = captions.build(take["cues"], take.get("words"), take.get("answer_start"), clean, SR)
                # Captions go at the top for a take where the mouth often comes down to where they'd be.
                at_top = False
                if track is not None:
                    s, _, oy = placement(size)
                    mouth = float(np.percentile(track[:, 1] + 0.75 * track[:, 3], 90)) * s + oy
                    at_top = mouth + 0.02 * OUT_H > captions.caption_top(OUT_H)
                ass = tmp / f"take{i}.ass"
                phrases = captions.write_ass(built, ass, OUT_W, OUT_H, at_top)
            entry = {
                "input": take["input"],
                "frames": frames,
                "seconds": round(frames / FPS, 3),
                "size": size,
                "grade": info["grade"],
                "measured": info["facts"],
                "audio": audio_report,
                "caption_phrases": phrases,
            }
            report["takes"].append(entry)

            def finish_take(i=i, take=take, info=info, pieces=pieces, audio_path=audio_path, ass=ass):
                done = [p.result() for p in pieces]
                encode(i, take, info, done, audio_path, ass, fonts, tmp)
                log(f"take {i + 1} finished: {take['output']}")

            pending.append(encoders.submit(finish_take))
        for p in pending:
            p.result()
    report["seconds_taken"] = round(time.time() - started, 1)
    print(json.dumps(report))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - whatever went wrong, the server joins the takes as recorded
        log(f"failed: {err!r}")
        sys.exit(1)
