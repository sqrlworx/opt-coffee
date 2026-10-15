#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#     "numpy",
#     "torch==2.7.1",
#     "diffusers==0.35.2",
#     "transformers>=4.51,<5",  # 4.51 for Qwen3
#     "accelerate",
#     "sentencepiece",  # the T5 tokenizer
#     "protobuf",
#     "huggingface_hub",
#     "pillow",
# ]
#
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""B-roll for an answer: a short clip made from the expert's description of it.

The server (src/broll/index.js) runs this once per clip with a job file:

    uv run broll.py job.json

    {"prompt": "show when eventual consistency is dangerous", "out": "media/x.mp4", "seconds": 4.2, "seed": 1234,
     "question": "When should I avoid eventual consistency?", "answer": "the answer's transcript, or null",
     "shot": "the shot already written up, or null", "image": "/tmp/x/frame.png, its first frame, or null"}

A video model can only film what it's told to see, and experts often describe an idea rather than
a shot. So first the description is written up as one concrete, filmable shot (shot.md), unless
the job brings one (src/broll/openai.js writes it with GPT when there's an OpenAI key): with Qwen3
8B (Apache-2.0, without its thinking), which picks a scene that stands for the idea, preferably the
example the expert gives in their answer. Then the clip is made of that shot with LTX-Video (2B,
distilled; Lightricks' open weights) at 1024x576 and 24 fps, as long as `seconds` rounds up to (the
model makes 8n + 1 frames), with no sound. With an `image`, the clip starts from it (cropped to
16:9) and the model animates it. The first run downloads the models (about 42 GB, cached by Hugging
Face afterwards). On a CPU it takes a few minutes. Logs go to stderr; the last line on stdout is a
JSON report, with the shot that was filmed. Exits non-zero on failure.
"""

from __future__ import annotations

import gc
import json
import subprocess
import sys
import time
from pathlib import Path

REPO = "Lightricks/LTX-Video"
REVISION = "8984fa25007f376c1a299016d0957a37a2f797bb"
# The transformer and the video VAE, in one file; the text encoder and tokenizer are T5's, in the repo's folders.
WEIGHTS = "ltxv-2b-0.9.8-distilled.safetensors"
WIDTH, HEIGHT = 1024, 576  # multiples of 32, as the model needs
FPS = 24
# The distilled model's schedule: eight steps, no classifier-free guidance.
TIMESTEPS = [1000, 993, 987, 981, 975, 909, 725, 421]
# Writes the shot from the expert's description.
WRITER = "Qwen/Qwen3-8B"
WRITER_REVISION = "b968826d9c46dd6066d109eabc6255188de91218"
SHOT_RULES = Path(__file__).with_name("shot.md")
MAX_ANSWER = 4000  # characters of the answer the writer reads
# If the shot can't be written, the description is filmed as it is, with this to make it look like footage.
STYLE = "Cinematic b-roll footage, realistic, natural light, smooth camera movement, shallow depth of field."
NEGATIVE = "worst quality, inconsistent motion, blurry, jittery, distorted, watermark, subtitles, logo"
CRF = 16


def log(msg: str) -> None:
    print(f"[broll] {msg}", file=sys.stderr, flush=True)


def frames_for(seconds: float) -> int:
    """At least `seconds` of frames, as 8n + 1."""
    n = max(1, -(-round(seconds * FPS - 1) // 8))
    return 8 * n + 1


def write_shot(prompt: str, question: str | None, answer: str | None) -> str:
    """The expert's description as one concrete shot the video model can film (see shot.md)."""
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(WRITER, revision=WRITER_REVISION)
    model = AutoModelForCausalLM.from_pretrained(WRITER, revision=WRITER_REVISION, torch_dtype=torch.bfloat16)
    brief = "\n".join(
        [
            *([f"<question>\n{question}\n</question>"] if question else []),
            *([f"<answer>\n{answer[:MAX_ANSWER]}\n</answer>"] if answer else []),
            f"<b_roll>\n{prompt}\n</b_roll>",
        ]
    )
    messages = [{"role": "system", "content": SHOT_RULES.read_text()}, {"role": "user", "content": brief}]
    inputs = tokenizer.apply_chat_template(messages, add_generation_prompt=True, enable_thinking=False, return_tensors="pt", return_dict=True)
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=220, do_sample=False)
    shot = " ".join(tokenizer.decode(out[0, inputs["input_ids"].shape[1] :], skip_special_tokens=True).split())
    del model
    gc.collect()  # its memory goes back before the video model loads
    if len(shot.split()) < 8:
        raise RuntimeError(f"the shot came out as {shot!r}")
    return shot


def first_frame(path: str):
    """The image the clip starts from, cropped to the clip's shape around its middle and scaled to it."""
    from PIL import Image, ImageOps

    return ImageOps.fit(Image.open(path).convert("RGB"), (WIDTH, HEIGHT), method=Image.Resampling.LANCZOS)


def load():
    import torch
    from diffusers import AutoencoderKLLTXVideo, FlowMatchEulerDiscreteScheduler, LTXConditionPipeline, LTXVideoTransformer3DModel
    from huggingface_hub import hf_hub_download
    from transformers import T5EncoderModel, T5Tokenizer

    dtype = torch.bfloat16
    weights = hf_hub_download(REPO, WEIGHTS, revision=REVISION)
    return LTXConditionPipeline(
        scheduler=FlowMatchEulerDiscreteScheduler(use_dynamic_shifting=False, shift=1.0),
        vae=AutoencoderKLLTXVideo.from_single_file(weights, torch_dtype=dtype),
        text_encoder=T5EncoderModel.from_pretrained(REPO, subfolder="text_encoder", revision=REVISION, torch_dtype=dtype),
        tokenizer=T5Tokenizer.from_pretrained(REPO, subfolder="tokenizer", revision=REVISION),
        transformer=LTXVideoTransformer3DModel.from_single_file(weights, torch_dtype=dtype),
    )


def write_video(frames, out: Path) -> None:
    """RGB frames (0-1 floats) as an H.264 MP4 that streams before it has fully downloaded."""
    import numpy as np

    part = out.with_name(out.name + ".part")
    enc = subprocess.Popen(
        ["ffmpeg", "-nostdin", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "slow", "-crf", str(CRF), "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
         "-movflags", "+faststart", "-f", "mp4", str(part)],
        stdin=subprocess.PIPE,
    )  # fmt: skip
    for frame in frames:
        enc.stdin.write((np.clip(frame, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes())
    enc.stdin.close()
    if enc.wait() != 0:
        part.unlink(missing_ok=True)
        raise RuntimeError("ffmpeg couldn't encode the clip")
    part.replace(out)


def main() -> None:
    import torch

    started = time.time()
    job = json.loads(Path(sys.argv[1]).read_text())
    prompt = " ".join(str(job["prompt"]).split())
    frames = frames_for(float(job["seconds"]))
    shot = " ".join(str(job.get("shot") or "").split())
    filmed = shot
    if not shot:
        log(f"writing up the shot for: {prompt} (the first time, this downloads the model)")
        try:
            shot = filmed = write_shot(prompt, job.get("question"), job.get("answer"))
        except Exception as err:  # noqa: BLE001 - the description can still be filmed as it is
            log(f"couldn't write up the shot, so the description is filmed as it is: {err!r}")
            shot = prompt
            filmed = f"{prompt.rstrip('.')}. {STYLE}"
    image = job.get("image")
    log("loading the video model (the first time, this downloads it)")
    pipe = load()
    pipe.set_progress_bar_config(disable=True)  # it logs its own steps
    log(f"making {frames} frames ({frames / FPS:.2f}s){' from its first frame' if image else ''} of: {filmed}")

    def progress(pipe, step, timestep, kwargs):
        log(f"step {step + 1} of {len(TIMESTEPS)}, {time.time() - started:.0f}s in")
        return kwargs

    from diffusers.pipelines.ltx.pipeline_ltx_condition import LTXVideoCondition

    with torch.inference_mode():
        video = pipe(
            conditions=[LTXVideoCondition(image=first_frame(image), frame_index=0)] if image else None,
            prompt=filmed,
            negative_prompt=NEGATIVE,
            width=WIDTH,
            height=HEIGHT,
            num_frames=frames,
            frame_rate=FPS,
            timesteps=TIMESTEPS,
            guidance_scale=1.0,
            image_cond_noise_scale=0.0,
            decode_timestep=0.05,
            decode_noise_scale=0.025,
            generator=torch.Generator().manual_seed(int(job.get("seed") or 0)),
            output_type="np",
            callback_on_step_end=progress,
        ).frames[0]
    write_video(video, Path(job["out"]))
    report = {"shot": shot, "frames": frames, "seconds": round(frames / FPS, 3), "width": WIDTH, "height": HEIGHT, "seconds_taken": round(time.time() - started, 1)}
    log(f"done in {report['seconds_taken']}s: {job['out']}")
    print(json.dumps(report))


if __name__ == "__main__":
    try:
        main()
    except Exception as err:  # noqa: BLE001 - whatever went wrong, the expert sees that it failed
        log(f"failed: {err!r}")
        sys.exit(1)
