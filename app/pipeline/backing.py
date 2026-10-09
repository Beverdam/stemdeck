"""Backing tracks: a song without one of its stems, mixed on demand.

Streamer Mode lets a musician play one part themselves ("I play: Bass") over
the rest of the song. Demucs always leaves all six stems on disk
(stems/<name>.wav, STEM_NAMES), whatever the user selected at import, so the
backing is the sum of every stem file but the removed one: no separation runs
again.

The file is kept beside the job, `backing_without_<stem>.wav`, with a small
`.json` beside it naming the stem files it was mixed from (size and mtime).
An existing file whose sources are unchanged is never rebuilt; one whose stems
changed (a re-split) is. One build per (job, stem) at a time: a second caller
waits for the first and then finds the file.

Voice is the vocals stem. vocals.wav holds lead and backing vocals together
and is never deleted by the on-demand lead/backing split (#275), so removing
it removes both; the split files are never mixed in. A job whose vocals.wav
is missing but whose split exists falls back to the two split files for the
"everything but X" sum, and leaves both out when Voice is removed.

The mix sums the stems as make_original_track does (amix normalize=0: each
at its own level), in float, and is written as 16-bit PCM at the stems' rate.
Demucs stems sum back to about the original song, so leaving one out stays at
or below the song's level; should the sum still pass full scale (a stem that
was cancelling another), the whole file is scaled down to just under it
rather than clipped.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

from app.core.config import EXTRA_STEM_NAMES, STEM_NAMES

logger = logging.getLogger("stemdeck.backing")

# The stems a backing can leave out: the six Demucs stems.
REMOVABLE = STEM_NAMES
_PEAK_CEILING = 0.999
_BLOCK = 1 << 16

_locks: dict[tuple[str, str], threading.Lock] = {}
_locks_guard = threading.Lock()


class BackingError(RuntimeError):
    """The backing could not be made (stems missing or unreadable)."""


def backing_path(job_dir: Path, remove: str) -> Path:
    return job_dir / f"backing_without_{remove}.wav"


def backing_inputs(stems_dir: Path, remove: str) -> list[Path]:
    """The stem files the backing without `remove` is the sum of."""
    if remove not in REMOVABLE:
        raise ValueError(f"unknown stem {remove!r}")
    names = [n for n in STEM_NAMES if n != remove]
    paths = [stems_dir / f"{n}.wav" for n in names]
    present = [p for p in paths if p.is_file()]
    vocals_gone = not (stems_dir / "vocals.wav").is_file()
    if remove != "vocals" and vocals_gone:
        # No vocals.wav but a finished split: its two halves stand in for it.
        split = [stems_dir / f"{n}.wav" for n in EXTRA_STEM_NAMES]
        if all(p.is_file() for p in split):
            present += split
    return present


def _signature(paths: list[Path]) -> dict[str, list[int]]:
    out = {}
    for p in paths:
        st = p.stat()
        out[p.name] = [st.st_size, st.st_mtime_ns]
    return out


def _fresh(out: Path, meta: Path, paths: list[Path]) -> bool:
    if not out.is_file() or not meta.is_file():
        return False
    try:
        return json.loads(meta.read_text(encoding="utf-8")).get("sources") == _signature(paths)
    except (OSError, ValueError):
        return False


def _lock(job_id: str, remove: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault((job_id, remove), threading.Lock())


def _mix(paths: list[Path], out: Path) -> float:
    """Sum `paths` into `out` (16-bit PCM). Returns the gain applied (1.0
    unless the sum passed full scale). Two passes over the files, a block at
    a time: the peak, then the write."""
    infos = [sf.info(str(p)) for p in paths]
    rate = infos[0].samplerate
    channels = max(i.channels for i in infos)
    if any(i.samplerate != rate for i in infos):
        raise BackingError("stems at different sample rates")
    frames = max(i.frames for i in infos)

    def blocks():
        handles = [sf.SoundFile(str(p)) for p in paths]
        try:
            done = 0
            while done < frames:
                n = min(_BLOCK, frames - done)
                acc = np.zeros((n, channels), dtype=np.float64)
                for h in handles:
                    data = h.read(n, dtype="float64", always_2d=True)
                    if data.shape[1] == 1 and channels > 1:
                        data = np.repeat(data, channels, axis=1)
                    acc[: data.shape[0]] += data
                yield acc
                done += n
        finally:
            for h in handles:
                h.close()

    peak = 0.0
    for acc in blocks():
        peak = max(peak, float(np.max(np.abs(acc))) if acc.size else 0.0)
    gain = 1.0 if peak <= _PEAK_CEILING else _PEAK_CEILING / peak
    with sf.SoundFile(
        str(out), "w", samplerate=rate, channels=channels, subtype="PCM_16", format="WAV"
    ) as w:
        for acc in blocks():
            w.write(acc * gain if gain != 1.0 else acc)
    return gain


def ensure_backing(job_id: str, job_dir: Path, remove: str) -> tuple[Path, bool]:
    """The backing without `remove` for the job in `job_dir`, built when it is
    missing or stale. Returns (path, built). Blocking; one build per (job,
    stem) at a time. Raises ValueError for an unknown stem, BackingError when
    there is nothing to mix."""
    stems_dir = job_dir / "stems"
    paths = backing_inputs(stems_dir, remove)
    if not paths:
        raise BackingError("no stems to mix")
    out = backing_path(job_dir, remove)
    meta = out.with_suffix(".json")
    with _lock(job_id, remove):
        if _fresh(out, meta, paths):
            return out, False
        tmp = out.with_name(f".{out.name}.{uuid.uuid4().hex}.tmp.wav")
        try:
            gain = _mix(paths, tmp)
            os.replace(tmp, out)
        except (OSError, RuntimeError, ValueError) as exc:
            raise BackingError("the backing could not be mixed") from exc
        finally:
            tmp.unlink(missing_ok=True)
        meta.write_text(
            json.dumps({"removed": remove, "sources": _signature(paths), "gain": gain}),
            encoding="utf-8",
        )
        if gain != 1.0:
            logger.info(
                "[%s] backing without %s scaled by %.4f to stay unclipped", job_id, remove, gain
            )
        return out, True
