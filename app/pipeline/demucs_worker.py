"""Persistent demucs worker (#309).

Run as its own process: `python -m app.pipeline.demucs_worker <device>`.
Loads the model once, then serves jobs one at a time over stdin/stderr --
eliminating the torch import + model load + CUDA kernel warmup cost that
dominated repeated per-job subprocess spawns on GPU (measured 35-42% of the
separate stage on an RTX 3080; see #288/#309). The parent (separate.py)
keeps this process alive across consecutive successful jobs on the same
device and only tears it down on cancel or a genuine failure.

Protocol:
  - Parent writes one JSON line to stdin per job:
      {"source": "<path>", "job_dir": "<path>", "shifts": 1,
       "vocals_model": "demucs" | "roformer"}
    ("vocals_model" absent means "demucs".)
  - Normal demucs progress (tqdm, \\r-delimited "NN%" lines) streams to
    stderr exactly as it would from the demucs CLI -- apply_model(progress=
    True) is the same call the CLI itself makes, unchanged from what
    separate.py's reader already parsed from a one-shot subprocess.
  - A "roformer" job runs in phases, each announced on its own line before
    its "NN%" lines: "@@PHASE@@download" (first use only, the vocals model),
    "@@PHASE@@vocals" and "@@PHASE@@instruments".
  - On completion the worker writes one more stderr line and, only on
    failure, exits:
      "@@DONE@@"                          -- job ok, worker keeps serving
      "@@ERROR@@<json-encoded message>"   -- job failed, worker exits(1)
    A job failure always exits the worker rather than trying to keep
    serving: after an exception mid-inference (OOM-adjacent or not), GPU
    memory / CUDA context state for future jobs isn't something we can
    vouch for, so the parent respawns fresh rather than risk reusing a
    worker in an unknown state. This matches today's behavior, where any
    failure already meant "process is dead, next attempt spawns fresh" --
    the reuse win only applies to the happy path.
  - EOF on stdin (parent closed the pipe) ends the worker's loop cleanly.
  - STEMDECK_PARENT_PID, if set, arms a watchdog that exits the worker when
    that process disappears. See _watch_parent for why the pipe alone is not
    enough.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from app.core.config import DEMUCS_MODEL, MODELS_DIR
from app.core.process import arm_parent_watchdog

# The vocals RoFormer, loaded on the first "roformer" job and kept, like the
# Demucs model, for the worker's lifetime.
_roformer: list[object] = []


def _say(line: str) -> None:
    sys.stderr.write(line + "\n")
    sys.stderr.flush()


def _percent(pct: int) -> None:
    _say(f"{pct}%")


def _demucs(model, wav, device: str, shifts: int):
    """Demucs over ``wav`` (channels x samples): one tensor per model.sources."""
    from demucs.apply import apply_model

    # Identical to demucs.separate.main()'s per-track body (same functions,
    # same default split/overlap/segment/clip/bit-depth) -- we're not
    # reimplementing the audio pipeline, just calling it repeatedly on an
    # already-loaded model instead of once per fresh process.
    ref = wav.mean(0)
    wav = wav - ref.mean()
    wav = wav / ref.std()
    sources = apply_model(
        model,
        wav[None],
        device=device,
        shifts=shifts,
        split=True,
        overlap=0.25,
        progress=True,
        num_workers=0,
        segment=None,
    )[0]
    sources = sources * ref.std()
    return sources + ref.mean()


def _load_roformer():
    if not _roformer:
        from app.core.model_cache import load_or_heal
        from app.pipeline import vocals_roformer

        def load():
            # Only a first use downloads, and only then is there a phase to show.
            if not vocals_roformer.checkpoint_path(MODELS_DIR).is_file():
                _say("@@PHASE@@download")
            return vocals_roformer.load_model(MODELS_DIR, _percent)

        _roformer.append(load_or_heal(load, lambda: [vocals_roformer.checkpoint_path(MODELS_DIR)]))
    return _roformer[0]


def _roformer_stems(model, wav, device: str, shifts: int) -> dict:
    """The six stems with the vocals from the RoFormer.

    Demucs separates the song minus those vocals, and "other" is whatever its
    drums, bass, guitar and piano leave of that, Demucs' own stray vocals
    included. So the stems add up to the original exactly, and playing every
    lane plays the song rather than a hollow approximation of it.
    """
    import torch

    from app.pipeline.vocals_roformer import separate_vocals

    roformer = _load_roformer()
    _say("@@PHASE@@vocals")
    roformer.to(device)
    try:
        vocals = separate_vocals(roformer, wav, device, _percent)
    finally:
        # Demucs gets the VRAM back: both models resident does not fit every GPU.
        roformer.cpu()
        if device == "cuda":
            torch.cuda.empty_cache()
    rest = wav - vocals
    _say("@@PHASE@@instruments")
    by_name = dict(zip(model.sources, _demucs(model, rest, device, shifts), strict=True))
    stems = {"vocals": vocals}
    for name in model.sources:
        if name not in ("vocals", "other"):
            stems[name] = by_name[name]
    stems["other"] = rest - sum(stems[n] for n in stems if n != "vocals")
    return stems


def _run_one_job(model, device: str, req: dict) -> None:
    from demucs.audio import save_audio
    from demucs.separate import load_track

    source = Path(req["source"])
    job_dir = Path(req["job_dir"])
    shifts = int(req.get("shifts", 1))

    wav = load_track(source, model.audio_channels, model.samplerate)
    if req.get("vocals_model") == "roformer":
        by_name = _roformer_stems(model, wav, device, shifts)
        sources = [by_name[name] for name in model.sources]
    else:
        sources = _demucs(model, wav, device, shifts)

    out_dir = job_dir / DEMUCS_MODEL / source.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    for stem_tensor, name in zip(sources, model.sources, strict=True):
        save_audio(
            stem_tensor,
            str(out_dir / f"{name}.wav"),
            samplerate=model.samplerate,
            clip="rescale",
            bits_per_sample=16,
            as_float=False,
        )


def main() -> None:
    device = sys.argv[1] if len(sys.argv) > 1 else "cpu"
    arm_parent_watchdog()

    from demucs.pretrained import get_model

    model = get_model(DEMUCS_MODEL)
    model.eval()
    model.cpu()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            _run_one_job(model, device, req)
        except Exception as e:
            sys.stderr.write(f"@@ERROR@@{json.dumps(str(e))}\n")
            sys.stderr.flush()
            sys.exit(1)
        sys.stderr.write("@@DONE@@\n")
        sys.stderr.flush()


if __name__ == "__main__":
    main()
