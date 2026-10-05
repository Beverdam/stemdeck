"""ffmpeg work for recorded takes: the playable audio and the video render.

Everything here is blocking and runs in a thread (asyncio.to_thread) from
app/api/takes.py. The command builders are pure functions so the filter
graphs can be tested without running ffmpeg.

Sign convention, shared with the capture layer in the browser: a positive
latency or offset means the material arrived late, so it is subtracted.
"""

from __future__ import annotations

import logging
import math
import os
import re
import shutil
import struct
import subprocess
import threading
import time
import uuid
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import NamedTuple

import soundfile as sf

from app.core.config import EXPORT_LIMIT_DBFS, TIMEOUT_FFMPEG, ffmpeg_executable

logger = logging.getLogger("stemdeck.takes")

# The stems' own format (app/pipeline/collect.py writes pcm_s16le; Demucs
# output is 44.1 kHz stereo). A take in exactly this format needs no
# take-specific code in the chunked engine, the peaks, the mixdown or the zip.
TAKE_RATE = 44100
TAKE_CHANNELS = 2

# alimiter's limit is linear. level=disabled stops it re-normalising the
# output to 0 dB (its default does, measured -12.8 instead of -14 LUFS in the
# mastering study) and latency=1 removes its look-ahead delay, so a lane
# keeps its timing to the sample. Measured on the bundled ffmpeg 8.1: with a
# signal under the limit the output is bit-identical to the input, same
# length; two 0.7 sines summed (52152 samples at full scale without it) peak
# at exactly -1.0 dBFS with none at full scale.
EXPORT_LIMITER = f"alimiter=limit={10 ** (EXPORT_LIMIT_DBFS / 20):.6f}:level=disabled:latency=1"


class TakeRenderError(RuntimeError):
    """ffmpeg failed. The message is for the log, never for the client."""


def write_float_wav_header(fh, data_bytes: int, rate: int, channels: int) -> None:
    """A WAVE_FORMAT_IEEE_FLOAT (3) header for 32-bit interleaved samples.

    The stdlib wave module writes integer PCM only, and the raw capture is
    float32: kept bit-exact so a later re-render (a nudge, an import on
    another machine) starts from what the microphone delivered."""
    block_align = channels * 4
    fh.write(b"RIFF")
    fh.write(struct.pack("<I", 36 + data_bytes))
    fh.write(b"WAVE")
    fh.write(b"fmt ")
    fh.write(struct.pack("<IHHIIHH", 16, 3, channels, rate, rate * block_align, block_align, 32))
    fh.write(b"data")
    fh.write(struct.pack("<I", data_bytes))


def assemble_raw_wav(pcm: Path, dest: Path, rate: int, channels: int) -> None:
    """Wrap the uploaded float32 parts in a WAV header, atomically."""
    size = pcm.stat().st_size
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
    try:
        with tmp.open("wb") as out, pcm.open("rb") as src:
            write_float_wav_header(out, size, rate, channels)
            shutil.copyfileobj(src, out, 1024 * 1024)
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


def wav_frames(path: Path) -> int:
    return int(sf.info(str(path)).frames)


def sniff_container(path: Path) -> str | None:
    """ "webm" or "mp4" from the first bytes, or None.

    The browser picks the container (WebM on Chromium and Firefox, MP4 on
    Safari/WKWebView), and a declared MIME type is only a claim. The file
    name decides which demuxer the render trusts, so it comes from the bytes."""
    try:
        with path.open("rb") as fh:
            head = fh.read(12)
    except OSError:
        return None
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"
    if len(head) >= 8 and head[4:8] == b"ftyp":
        return "mp4"
    return None


def take_audio_filter(placement_sec: float, frames: int, source_channels: int) -> str:
    """The -af chain that turns a raw take into a playable one.

    Resampled to 44.1 kHz first, then placed in output samples, so the
    placement is rounded once at the output rate (at most half a sample out)
    rather than at the capture rate and again by the resampler. A take that
    starts before song 0 (count-in, pickup notes, the latency it is
    compensated for) is trimmed; one that starts after is delayed. Padded with
    silence and cut to exactly the stems' frame count, so every lane has the
    same length.
    """
    parts: list[str] = []
    if source_channels == 1:
        # Explicit, rather than -ac 2: the mono capture goes to both channels
        # at unity, with no up-mix coefficients in between.
        parts.append("pan=stereo|c0=c0|c1=c0")
    parts.append(f"aresample={TAKE_RATE}")
    offset = int(round(placement_sec * TAKE_RATE))
    if offset < 0:
        parts.append(f"atrim=start_sample={-offset}")
        parts.append("asetpts=PTS-STARTPTS")
    elif offset > 0:
        parts.append(f"adelay=delays={offset}S:all=1")
    parts.append(f"apad=whole_len={frames}")
    parts.append(f"atrim=end_sample={frames}")
    return ",".join(parts)


def _run(cmd: list[str], timeout: int, context: str) -> None:
    proc = subprocess.run(  # noqa: S603 -- list args, no shell, trusted ffmpeg
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )
    if proc.returncode != 0:
        tail = proc.stderr[-2000:].decode("utf-8", "replace")
        raise TakeRenderError(f"ffmpeg failed [{context}]: {tail}")


def render_take_audio(
    raw: Path,
    dest: Path,
    placement_sec: float,
    frames: int,
    source_rate: int,
    source_channels: int,
) -> None:
    """Render audio.wav from audio.raw.wav. Blocking; written atomically.

    `placement_sec` is the song time of raw frame 0, everything already
    folded in (round trip, nudge). `frames` is the stems' frame count."""
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp.wav")
    raw_end = placement_sec + wav_frames(raw) / source_rate
    try:
        if raw_end <= 0 or placement_sec * TAKE_RATE >= frames:
            # Nothing of the take lands inside the song: an all-silent lane
            # of the right length rather than an ffmpeg graph with no frames.
            cmd = [
                ffmpeg_executable(),
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r={TAKE_RATE}:cl=stereo",
                "-af",
                f"atrim=end_sample={frames}",
            ]
        else:
            cmd = [
                ffmpeg_executable(),
                "-nostdin",
                "-loglevel",
                "error",
                "-i",
                str(raw),
                "-af",
                take_audio_filter(placement_sec, frames, source_channels),
            ]
        cmd += [
            "-ac",
            str(TAKE_CHANNELS),
            "-ar",
            str(TAKE_RATE),
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-y",
            str(tmp),
        ]
        _run(cmd, TIMEOUT_FFMPEG, f"take audio {raw.parent.name}")
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Video render


_encoders_cached: str | None = None
_encoders_lock = threading.Lock()


def _encoders() -> str:
    """`ffmpeg -encoders`, probed once per process (the binary cannot change
    mid-run). Any probe failure reads as an empty list, so the render says
    the encoder is missing rather than starting and failing later."""
    global _encoders_cached
    with _encoders_lock:
        if _encoders_cached is None:
            try:
                probe = subprocess.run(  # noqa: S603 -- fixed args, trusted ffmpeg
                    [ffmpeg_executable(), "-hide_banner", "-encoders"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                _encoders_cached = probe.stdout
            except (OSError, subprocess.SubprocessError):
                logger.debug(
                    "encoder probe failed; treating video render as unavailable", exc_info=True
                )
                _encoders_cached = ""
        return _encoders_cached


def libx264_available() -> bool:
    """libx264 is GPL and left out of LGPL builds (some distro and Homebrew
    variants), so it is probed like rubberband rather than assumed."""
    return bool(re.search(r"^\s*V\S*\s+libx264\b", _encoders(), re.MULTILINE))


def aac_available() -> bool:
    """ffmpeg's native AAC encoder; present in every build seen, probed anyway."""
    return bool(re.search(r"^\s*A\S*\s+aac\b", _encoders(), re.MULTILINE))


class AudioLane(NamedTuple):
    path: Path
    gain: float
    pitch_filter: str  # "" or "rubberband=...," as stems._pitch_filter builds it


CANVAS_SIZES = {"16:9": (1920, 1080), "9:16": (1080, 1920)}
VIDEO_FPS = 30


def camera_filter(
    start_sec: float, width: int, height: int, fit: str, mirror: bool, label_in: str
) -> str:
    """Scale, crop or letterbox one camera into the canvas and place it in
    song time. `start_sec` is the song time of the camera's first frame: when
    negative, the front is cut; when positive, the frames are shifted later
    and the canvas shows black until they arrive."""
    chain: list[str] = []
    if start_sec < 0:
        chain.append(f"trim=start={-start_sec:.6f}")
        chain.append("setpts=PTS-STARTPTS")
    else:
        chain.append(f"setpts=PTS-STARTPTS+{start_sec:.6f}/TB")
    if fit == "contain":
        chain.append(f"scale={width}:{height}:force_original_aspect_ratio=decrease")
        chain.append(f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black")
    else:
        chain.append(f"scale={width}:{height}:force_original_aspect_ratio=increase")
        chain.append(f"crop={width}:{height}")
    if mirror:
        chain.append("hflip")
    chain.append("setsar=1")
    return f"{label_in}{','.join(chain)}[cam]"


def build_video_render_cmd(
    lanes: list[AudioLane],
    take_audio: Path,
    take_gain: float,
    camera: Path,
    camera_start_sec: float,
    duration_sec: float,
    canvas: str,
    fit: str,
    mirror: bool,
    audio_rate: int,
) -> list[str]:
    """One ffmpeg command: backing mix + take audio + one camera tile -> MP4.

    The audio graph is the export's (per-lane pitch and gain, amix with
    normalize=0, the export limiter), with the take as one more lane at no
    offset: audio.wav is already aligned to song 0. The output has no path;
    the caller appends -progress and the destination."""
    width, height = CANVAS_SIZES[canvas]
    cmd: list[str] = [ffmpeg_executable(), "-nostdin", "-loglevel", "error"]
    for lane in lanes:
        cmd += ["-i", str(lane.path)]
    take_idx = len(lanes)
    cam_idx = take_idx + 1
    cmd += ["-i", str(take_audio), "-i", str(camera)]

    filters = [
        f"[{i}:a]{lane.pitch_filter}volume={lane.gain:.6f}[a{i}]" for i, lane in enumerate(lanes)
    ]
    filters.append(f"[{take_idx}:a]volume={take_gain:.6f}[a{take_idx}]")
    n = take_idx + 1
    if n > 1:
        labels = "".join(f"[a{i}]" for i in range(n))
        filters.append(f"{labels}amix=inputs={n}:normalize=0,{EXPORT_LIMITER}[aout]")
    else:
        filters.append(f"[a0]{EXPORT_LIMITER}[aout]")

    filters.append(f"color=c=black:s={width}x{height}:r={VIDEO_FPS}:d={duration_sec:.6f}[bg]")
    filters.append(camera_filter(camera_start_sec, width, height, fit, mirror, f"[{cam_idx}:v]"))
    # eof_action=pass: once the camera ends the black canvas carries on, so
    # the video is always the song's length and never freezes on a last frame.
    filters.append(
        f"[bg][cam]overlay=eof_action=pass:shortest=0,fps={VIDEO_FPS},format=yuv420p[vout]"
    )
    cmd += [
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(VIDEO_FPS),
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        str(audio_rate),
        "-t",
        f"{duration_sec:.6f}",
        # moov before mdat: the file plays while it downloads and every
        # upload site takes it. Needs a seekable output, so this renders to a
        # file, never a pipe (unlike get_video_mixdown's fragmented stream).
        "-movflags",
        "+faststart",
    ]
    return cmd


class RenderCancelled(Exception):
    pass


def run_video_render(
    cmd: list[str],
    dest: Path,
    duration_sec: float,
    *,
    cancelled: Callable[[], bool],
    report: Callable[[float], None],
    on_proc: Callable[[subprocess.Popen | None], None],
    timeout: int,
) -> None:
    """Run the render to a temp file beside `dest`, reporting progress from
    ffmpeg's -progress stream, then rename it into place. Blocking.

    Raises RenderCancelled when `cancelled()` turns true (polled about every
    half second), TakeRenderError on any ffmpeg failure or timeout. Never
    leaves a partial file at `dest`."""
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp.mp4")
    full = [*cmd, "-progress", "pipe:1", "-nostats", "-f", "mp4", "-y", str(tmp)]
    proc = subprocess.Popen(  # noqa: S603 -- list args, no shell, trusted ffmpeg
        full,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    on_proc(proc)
    stderr_tail: deque[str] = deque(maxlen=40)

    def drain_stderr() -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            stderr_tail.append(line.rstrip())

    drain = threading.Thread(target=drain_stderr, daemon=True)
    drain.start()
    stop = threading.Event()

    def watchdog() -> None:
        # Cancellation and the overall timeout, checked off the reading
        # thread: the progress pipe can sit silent for a long time on a
        # slow encode, and a blocked readline must not delay either.
        deadline = time.monotonic() + timeout
        while not stop.wait(0.5):
            if cancelled() or time.monotonic() > deadline:
                if proc.poll() is None:
                    proc.kill()
                return

    guard = threading.Thread(target=watchdog, daemon=True)
    guard.start()
    ok = False
    try:
        for line in proc.stdout:  # type: ignore[union-attr]
            key, _, value = line.strip().partition("=")
            # out_time_us is microseconds; out_time_ms is too, despite its name.
            if key == "out_time_us" and value.lstrip("-").isdigit() and duration_sec > 0:
                report(max(0.0, min(0.99, int(value) / 1e6 / duration_sec)))
        proc.wait()
        drain.join(timeout=5)
        if cancelled():
            raise RenderCancelled()
        if proc.returncode != 0:
            raise TakeRenderError(
                f"video render exit {proc.returncode}: " + " | ".join(list(stderr_tail)[-8:])
            )
        os.replace(tmp, dest)
        ok = True
        report(1.0)
    finally:
        stop.set()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        on_proc(None)
        if not ok:
            tmp.unlink(missing_ok=True)


def is_finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
