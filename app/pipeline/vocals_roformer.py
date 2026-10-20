"""Mel-Band RoFormer vocals for the "roformer" separation model.

Demucs (htdemucs_6s) separates all six stems in one pass, but its vocals carry
audible bleed: brass, strings and piano in the voice, and a full mix that no
longer adds up to the song, which is what makes playback with every lane on
sound hollow. A Mel-Band RoFormer trained for vocals alone separates the voice
far more cleanly. With separation_model "roformer" the worker takes the vocals
from it, gives Demucs the song minus those vocals for the five other stems, and
makes "other" whatever Demucs leaves of that, so the six stems add up to the
original exactly (see demucs_worker._run_roformer_job).

The checkpoint is Kimberley Jensen's vocals model, downloaded on first use from
its author's Hugging Face repository (MIT, see docs/models.md) and checked
against a pinned SHA-256. Its architecture is audio-separator's MelBandRoformer,
which StemDeck already ships for the karaoke split, configured as in the
model's training config (ZFTurbo/Music-Source-Separation-Training, MIT).
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import urllib.request
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path

CHECKPOINT_URL = (
    "https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt"
)
CHECKPOINT_SHA256 = "87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e"
CHECKPOINT_NAME = "MelBandRoformer.ckpt"

# configs/KimberleyJensen/config_vocals_mel_band_roformer_kj.yaml, "model".
MODEL_KWARGS: dict[str, object] = {
    "dim": 384,
    "depth": 6,
    "stereo": True,
    "num_stems": 1,
    "time_transformer_depth": 1,
    "freq_transformer_depth": 1,
    "num_bands": 60,
    "dim_head": 64,
    "heads": 8,
    "attn_dropout": 0,
    "ff_dropout": 0,
    "flash_attn": True,
    "dim_freqs_in": 1025,
    "sample_rate": 44100,
    "stft_n_fft": 2048,
    "stft_hop_length": 441,
    "stft_win_length": 2048,
    "stft_normalized": False,
    "mask_estimator_depth": 2,
    "multi_stft_resolution_loss_weight": 1.0,
    "multi_stft_resolutions_window_sizes": (4096, 2048, 1024, 512, 256),
    "multi_stft_hop_size": 147,
    "multi_stft_normalized": False,
}
SAMPLE_RATE = 44100
# The same config's audio.chunk_size (8 s) and inference.num_overlap.
CHUNK = 352800
STEP = CHUNK // 2
# Chunks cross-fade over this many samples at each end.
FADE = CHUNK // 10
BATCH = 2

ProgressFn = Callable[[int], None]


def available() -> bool:
    """Whether this install can run the model. audio-separator is left out
    where its pins cannot be met (Intel macOS, see pyproject.toml), and the
    setting is offered nowhere it would fail."""
    return importlib.util.find_spec("audio_separator") is not None


def checkpoint_path(models_dir: Path) -> Path:
    return models_dir / "roformer" / CHECKPOINT_NAME


def ensure_checkpoint(models_dir: Path, progress: ProgressFn | None = None) -> Path:
    """The checkpoint, downloaded and verified when it is not there yet.

    Written to a .part file and moved into place only once its SHA-256
    matches, so a download cut short never leaves a file that looks complete.
    """
    path = checkpoint_path(models_dir)
    if path.is_file():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(".part")
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(CHECKPOINT_URL, timeout=60) as resp, part.open("wb") as out:  # nosec B310
            total = int(resp.headers.get("Content-Length") or 0)
            done, last = 0, -1
            while chunk := resp.read(1 << 20):
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                pct = done * 100 // total if total else 0
                if progress and pct != last:
                    progress(pct)
                    last = pct
        if digest.hexdigest() != CHECKPOINT_SHA256:
            raise RuntimeError(
                f"vocals model download did not match its checksum (got {digest.hexdigest()})"
            )
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)
    return path


def load_model(models_dir: Path, progress: ProgressFn | None = None):
    """The RoFormer with its weights, on the CPU.

    weights_only: the checkpoint is a pickle, and loading must not be able to
    run code from it. strict: a state dict that only partly fits would load
    "successfully" and separate nothing.
    """
    import torch
    from audio_separator.separator.uvr_lib_v5.roformer.mel_band_roformer import MelBandRoformer

    state = torch.load(
        ensure_checkpoint(models_dir, progress), map_location="cpu", weights_only=True
    )
    model = MelBandRoformer(**MODEL_KWARGS)
    model.load_state_dict(state, strict=True)
    return model.eval()


@contextmanager
def _contiguous_sdpa(device: str) -> Iterator[None]:
    """Hand scaled_dot_product_attention contiguous tensors on ROCm.

    torch 2.8.0+rocm6.4 on RDNA4 (gfx1201) returns garbage from SDPA, on every
    backend, when v's memory layout differs from k's, and this model's
    attention passes exactly that: a contiguous k beside a transposed view of
    v. Measured against the CPU, the vocals came out at -0.1 dB, which is no
    separation at all; made contiguous first they match it to 125 dB. Whisper
    and Demucs, checked against the CPU on the same card, are unaffected.
    Limited to this model's forward pass, and to ROCm, so nothing else
    changes.

    Fixed upstream by torch 2.14.1+rocm7.2 (checked on the same card), so this
    can go once the ROCm build StemDeck installs is that new; it stays on the
    2.8.0 line for torchaudio's soundfile backend (see torch_version_for_tag in
    the desktop shell).
    """
    import torch
    import torch.nn.functional as F

    if device == "cpu" or not getattr(torch.version, "hip", None):
        yield
        return
    real = F.scaled_dot_product_attention

    def sdpa(q, k, v, *args, **kwargs):
        return real(q.contiguous(), k.contiguous(), v.contiguous(), *args, **kwargs)

    F.scaled_dot_product_attention = sdpa
    try:
        yield
    finally:
        F.scaled_dot_product_attention = real


def separate_vocals(model, mix, device: str, progress: ProgressFn | None = None):
    """Vocals of ``mix`` (channels x samples, 44.1 kHz), same shape.

    The model sees 8 s at a time. Chunks overlap by half and cross-fade at
    their ends, and the song is padded so that every real sample sits where
    some chunk's window is fully open: no seams, and the edges of the song are
    not faded.

    On a CUDA (or ROCm) GPU it runs under fp16 autocast, as it was trained
    (use_amp in its config). Measured on an RX 9070 XT: 33x realtime against
    6x in fp32, and within 71 dB of the CPU's fp32 result, far below anything
    audible. MPS and the CPU stay in fp32.
    """
    from contextlib import nullcontext

    import torch

    n = mix.shape[-1]
    pad = CHUNK - STEP
    x = torch.nn.functional.pad(mix.float(), (pad, pad + CHUNK))
    window = torch.ones(CHUNK)
    window[:FADE] = torch.linspace(0, 1, FADE)
    window[-FADE:] = torch.linspace(1, 0, FADE)
    out = torch.zeros_like(x)
    weight = torch.zeros(x.shape[-1])
    starts = list(range(0, x.shape[-1] - CHUNK + 1, STEP))
    amp = torch.autocast("cuda", dtype=torch.float16) if device == "cuda" else nullcontext()
    with torch.no_grad(), _contiguous_sdpa(device), amp:
        for i in range(0, len(starts), BATCH):
            group = starts[i : i + BATCH]
            batch = torch.stack([x[:, s : s + CHUNK] for s in group]).to(device)
            y = model(batch)
            if y.ndim == 4:  # (batch, stems, channels, samples)
                y = y[:, 0]
            y = y.float().cpu()
            # The inverse STFT can come back a few samples short of the chunk.
            length = min(CHUNK, y.shape[-1])
            for j, s in enumerate(group):
                out[:, s : s + length] += y[j, :, :length] * window[:length]
                weight[s : s + length] += window[:length]
            if progress:
                progress(min(100, (i + len(group)) * 100 // len(starts)))
    return (out / weight.clamp(min=1e-8))[:, pad : pad + n]
