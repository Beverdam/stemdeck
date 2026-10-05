"""Recorded takes: upload, finish, edit, delete, serve, and the video render.

Contract (agreed with the recording and video frontends):

    POST   /api/jobs/{id}/takes                              create, 201 {take_id, label}
    PUT    /api/jobs/{id}/takes/{take_id}/parts/{kind}?seq=n raw bytes, kind audio|camera
    GET    /api/jobs/{id}/takes/{take_id}/parts              upload state, to resync
    POST   /api/jobs/{id}/takes/{take_id}/finish             sidecar -> audio.wav, job.takes
    PATCH  /api/jobs/{id}/takes/{take_id}                    label, user_nudge_ms, camera_offset_ms
    DELETE /api/jobs/{id}/takes/{take_id}
    GET    /api/jobs/{id}/takes/{take_id}/audio.wav          (and HEAD)
    GET    /api/jobs/{id}/takes/{take_id}/camera
    POST   /api/jobs/{id}/takes/{take_id}/render             202, background video render
    GET    /api/jobs/{id}/takes/{take_id}/render             progress
    POST   /api/jobs/{id}/takes/{take_id}/render/cancel
    GET    /api/jobs/{id}/takes/{take_id}/render.mp4

Placement: the sidecar's timeline.first_sample_song_sec already has the
round-trip latency folded in (the browser knows it); the server applies the
user's nudge, and is the only place that does, so changing it later can
re-render from the raw capture:

    placement_sec = first_sample_song_sec - user_nudge_ms / 1000

Positive means late, subtract: the same sign as every latency in the capture
layer.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, field_validator

from app.api import stems as stems_api
from app.core.config import (
    EXTRA_STEM_NAMES,
    JOB_ID_RE,
    JOBS_DIR,
    STEM_NAMES,
    TAKE_AUDIO_MAX_BYTES_PER_SEC,
    TAKE_CAMERA_MAX_BYTES_PER_SEC,
    TAKE_ID_RE,
    TAKE_MAX_PER_JOB,
    TAKE_MAX_SEQ,
    TAKE_PART_MAX_BYTES,
    TAKE_SLACK_SEC,
    TAKES_DIRNAME,
    TIMEOUT_VIDEO_RENDER,
    TRACK_ID_RE,
    TRACK_MAX_PER_JOB,
)
from app.core.models import Job, _set
from app.core.registry import get as registry_get
from app.core.registry import persist as registry_persist
from app.core.settings import get_export_sample_rate
from app.core.takes import (
    camera_file,
    make_track,
    new_track_id,
    normalise_tracks,
    take_dir,
    take_entry,
    write_tracks,
)
from app.pipeline.collect import merge_stem_peaks
from app.pipeline.runner import _pipeline_lock
from app.pipeline.take_render import (
    TAKE_RATE,
    AudioLane,
    RenderCancelled,
    TakeRenderError,
    aac_available,
    assemble_raw_wav,
    build_video_render_cmd,
    libx264_available,
    render_take_audio,
    run_video_render,
    sniff_container,
    wav_frames,
)

logger = logging.getLogger("stemdeck.api")

router = APIRouter(tags=["takes"])

PartKind = Literal["audio", "camera"]
_PART_KINDS = ("audio", "camera")
_STATE_FILE = "parts.json"
_SIDECAR_FILE = "take.json"
_RENDER_FILE = "render.mp4"
_LABEL_MAX = 80
_SESSION_MAX_BYTES = 8 * 1024
_NUDGE_MAX_MS = 2000.0
_CAMERA_OFFSET_MAX_MS = 5000.0
_RENDER_MAX_LANES = 32
_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")

# One lock per take: parts, finish, edit and delete of the same take never
# interleave, so the append offset and parts.json always agree. Keyed by
# "<job_id>/<take_id>"; at most TAKE_MAX_PER_JOB per job, dropped on delete.
_take_locks: dict[str, asyncio.Lock] = {}


def _lock_for(job_id: str, take_id: str) -> asyncio.Lock:
    key = f"{job_id}/{take_id}"
    lock = _take_locks.get(key)
    if lock is None:
        lock = _take_locks[key] = asyncio.Lock()
    return lock


# ---------------------------------------------------------------------------
# Validation helpers. Order, per the security skill: job id, then take id and
# kind whitelist, then the resolved path inside JOBS_DIR, then any I/O.


def _job_or_404(job_id: str) -> Job:
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(status_code=404, detail="job not ready")
    return job


def _take_or_404(job_id: str, take_id: str) -> tuple[Job, Path]:
    job = _job_or_404(job_id)
    if not TAKE_ID_RE.match(take_id):
        raise HTTPException(status_code=404, detail="take not found")
    folder = take_dir(job_id, take_id, JOBS_DIR)
    if folder is None or not folder.is_dir():
        raise HTTPException(status_code=404, detail="take not found")
    return job, folder


def _entry(job: Job, take_id: str) -> dict[str, Any] | None:
    return next((t for t in job.takes if t.get("id") == take_id), None)


def _finished_or_404(job_id: str, take_id: str) -> tuple[Job, Path, dict[str, Any]]:
    job, folder = _take_or_404(job_id, take_id)
    entry = _entry(job, take_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="take not finished")
    return job, folder, entry


def _clean_label(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not value or len(value) > _LABEL_MAX or _CONTROL_CHARS.search(value):
        raise ValueError(f"label must be 1 to {_LABEL_MAX} printable characters")
    return value


def _reject_constant(token: str) -> float:
    raise ValueError(f"{token} is not a number")


async def _parse_body(request: Request, model: type[BaseModel], *, empty_ok: bool = False):
    """Parse a JSON body into `model`, after the ids have been checked.

    Not a FastAPI body parameter, for two reasons. Order: a body parameter is
    validated before the handler runs, so a bad body on an unknown job was a
    422 instead of a 404. And NaN: json accepts the NaN and Infinity tokens,
    and FastAPI's 422 then echoes the offending input back, which it cannot
    serialise, so a NaN in a sidecar came back as a 500. Refused here, at
    parse time, and the 422 detail never repeats the input."""
    raw = await request.body()
    if not raw.strip():
        if empty_ok:
            return model()
        raise HTTPException(status_code=422, detail="request body required")
    try:
        data = json.loads(raw, parse_constant=_reject_constant)
    except ValueError:
        raise HTTPException(
            status_code=422, detail="body must be JSON with finite numbers"
        ) from None
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        detail = "; ".join(
            f"{'.'.join(str(p) for p in err['loc']) or 'body'}: {err['msg']}"
            for err in exc.errors(include_input=False, include_url=False)[:5]
        )
        raise HTTPException(status_code=422, detail=detail[:500]) from None


# ---------------------------------------------------------------------------
# Small file helpers, all blocking.


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("could not read %s", path, exc_info=True)
        raise HTTPException(status_code=500, detail="take is unreadable") from None
    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail="take is unreadable")
    return data


def _new_state(label: str) -> dict[str, Any]:
    return {
        "label": label,
        "created_at": time.time(),
        "finished": False,
        **{kind: {"next_seq": 0, "bytes": 0} for kind in _PART_KINDS},
    }


def _reference_stem(job_id: str) -> Path | None:
    """A stem whose length every take is cut to. Any of them: the pipeline
    writes all of them from one Demucs pass, so they share a frame count."""
    stems_dir = (JOBS_DIR / job_id / "stems").resolve()
    if not stems_dir.is_relative_to(JOBS_DIR.resolve()):
        return None
    for name in (*STEM_NAMES, *EXTRA_STEM_NAMES, "original"):
        path = stems_dir / f"{name}.wav"
        if path.is_file():
            return path
    return None


def _song_frames(job_id: str) -> int:
    ref = _reference_stem(job_id)
    if ref is None:
        raise HTTPException(status_code=404, detail="stems not found")
    return wav_frames(ref)


def _size_cap(job: Job, kind: str) -> int:
    seconds = (job.duration_sec or 3600.0) + TAKE_SLACK_SEC
    per_sec = TAKE_AUDIO_MAX_BYTES_PER_SEC if kind == "audio" else TAKE_CAMERA_MAX_BYTES_PER_SEC
    return int(seconds * per_sec)


def _placement_sec(sidecar: dict[str, Any]) -> float:
    timeline = sidecar.get("timeline") or {}
    latency = sidecar.get("latency") or {}
    return float(timeline.get("first_sample_song_sec") or 0.0) - (
        float(latency.get("user_nudge_ms") or 0.0) / 1000.0
    )


def _refresh_peaks(job_id: str, take_id: str, folder: Path, *, remove: bool = False) -> None:
    stems_dir = (JOBS_DIR / job_id / "stems").resolve()
    if not stems_dir.is_dir() or not stems_dir.is_relative_to(JOBS_DIR.resolve()):
        return
    if remove:
        merge_stem_peaks(stems_dir, [], remove=[take_id])
    else:
        merge_stem_peaks(stems_dir, [take_id], sources={take_id: folder / "audio.wav"})


def _commit(job: Job, takes: list[dict[str, Any]], tracks: list[dict[str, Any]]) -> None:
    """Write tracks and takes together: tracks.json first (the file wins on
    load), then the job, through _set so the SSE stream sees one change, then
    the registry. Synchronous and free of awaits on purpose: every read and
    write of job.tracks happens inside one event-loop step, so two requests
    can never interleave a read-modify-write of the track list."""
    tracks = normalise_tracks(tracks, takes)
    if tracks != job.tracks:
        write_tracks(JOBS_DIR / job.id, tracks)
    _set(job, takes=takes, tracks=tracks)
    registry_persist(JOBS_DIR)


def _replace_entry(
    job: Job, entry: dict[str, Any] | None, take_id: str, *, activate: bool = False
) -> None:
    """Swap one take's record in job.takes (None removes it) and persist.

    With `activate`, the take becomes its track's active take, creating the
    track when it is missing (a take opened before tracks existed). Removing
    the active take falls back to the track's newest remaining one."""
    takes = [t for t in job.takes if t.get("id") != take_id]
    tracks = [dict(t) for t in job.tracks]
    if entry is not None:
        takes.append(entry)
        takes.sort(key=lambda t: t.get("created_at") or 0.0)
        if activate:
            track = next((t for t in tracks if t["id"] == entry.get("track_id")), None)
            if track is None:
                track = make_track(entry["track_id"], entry["label"], len(tracks))
                tracks.append(track)
            track["active_take_id"] = take_id
    _commit(job, takes, tracks)


def _track_or_404(job: Job, track_id: str) -> dict[str, Any]:
    if not TRACK_ID_RE.match(track_id):
        raise HTTPException(status_code=404, detail="track not found")
    track = next((t for t in job.tracks if t.get("id") == track_id), None)
    if track is None:
        raise HTTPException(status_code=404, detail="track not found")
    return track


# ---------------------------------------------------------------------------
# Create


class CreateTakeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    track_id: str | None = Field(default=None, max_length=16)
    label: str | None = Field(default=None, max_length=_LABEL_MAX * 4)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        return _clean_label(v)


@router.post("/{job_id}/takes", status_code=201)
async def create_take(job_id: str, request: Request) -> dict[str, str]:
    """Open a new take folder on a recording track: {"track_id", "label"?}."""
    job = _job_or_404(job_id)
    body = await _parse_body(request, CreateTakeBody, empty_ok=True)
    if body.track_id is None:
        raise HTTPException(status_code=422, detail="track_id required")
    if not TRACK_ID_RE.match(body.track_id) or not any(
        t.get("id") == body.track_id for t in job.tracks
    ):
        raise HTTPException(status_code=422, detail="unknown track")
    track_id = body.track_id
    on_track = sum(1 for t in job.takes if t.get("track_id") == track_id)

    root = (JOBS_DIR / job_id / TAKES_DIRNAME).resolve()
    if not root.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")

    def make() -> tuple[str, str]:
        root.mkdir(parents=True, exist_ok=True)
        existing = [p for p in root.iterdir() if p.is_dir() and TAKE_ID_RE.match(p.name)]
        if len(existing) >= TAKE_MAX_PER_JOB:
            raise HTTPException(status_code=409, detail="too many takes for this song")
        label = body.label or f"Take {on_track + 1}"
        for _ in range(8):
            take_id = "t" + secrets.token_hex(4)
            folder = root / take_id
            try:
                folder.mkdir()
            except FileExistsError:
                continue
            _write_json_atomic(folder / _STATE_FILE, {**_new_state(label), "track_id": track_id})
            return take_id, label
        raise HTTPException(status_code=500, detail="could not create take")

    take_id, label = await asyncio.to_thread(make)
    logger.info("[%s] take %s created on track %s", job.id, take_id, track_id)
    return {"take_id": take_id, "label": label, "track_id": track_id}


# ---------------------------------------------------------------------------
# Parts


async def _read_body_capped(request: Request) -> bytes:
    """The raw body, refused past TAKE_PART_MAX_BYTES while it streams in.
    The middleware already refuses a declared length over 4 MB; this covers a
    body longer than the length it declared."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > TAKE_PART_MAX_BYTES:
            raise HTTPException(status_code=413, detail="part too large")
        chunks.append(chunk)
    return b"".join(chunks)


@router.put("/{job_id}/takes/{take_id}/parts/{kind}")
async def put_part(
    job_id: str,
    take_id: str,
    kind: str,
    request: Request,
    seq: int = Query(..., ge=0, le=TAKE_MAX_SEQ),
) -> dict[str, Any]:
    """Append one part. seq must be exactly the next one; repeating the last
    one is a no-op, so a retry after a lost response is safe."""
    job, folder = _take_or_404(job_id, take_id)
    if kind not in _PART_KINDS:
        raise HTTPException(status_code=404, detail="unknown part kind")
    data = await _read_body_capped(request)
    if not data:
        raise HTTPException(status_code=422, detail="empty part")
    if kind == "audio" and len(data) % 4:
        raise HTTPException(status_code=422, detail="audio part must be whole float32 samples")

    async with _lock_for(job_id, take_id):
        state_path = folder / _STATE_FILE
        state = await asyncio.to_thread(_read_json, state_path)
        if state.get("finished"):
            raise HTTPException(status_code=409, detail="take already finished")
        slot = state.setdefault(kind, {"next_seq": 0, "bytes": 0})
        next_seq = int(slot.get("next_seq", 0))
        received = int(slot.get("bytes", 0))
        if next_seq > 0 and seq == next_seq - 1:
            return {
                "take_id": take_id,
                "kind": kind,
                "seq": seq,
                "bytes": received,
                "duplicate": True,
            }
        if seq != next_seq:
            raise HTTPException(status_code=409, detail="unexpected part sequence")
        if received + len(data) > _size_cap(job, kind):
            raise HTTPException(status_code=413, detail="take too large for this song")

        def append() -> None:
            part = folder / f"{kind}.part"
            with part.open("ab") as fh:
                # Cut back to what parts.json says arrived: a crash between
                # the write and the state update must not leave the part
                # that will be retried in the file twice.
                fh.truncate(received)
                fh.seek(received)
                fh.write(data)
            slot["next_seq"] = seq + 1
            slot["bytes"] = received + len(data)
            _write_json_atomic(state_path, state)

        await asyncio.to_thread(append)
    return {
        "take_id": take_id,
        "kind": kind,
        "seq": seq,
        "bytes": received + len(data),
        "duplicate": False,
    }


@router.get("/{job_id}/takes/{take_id}/parts")
async def get_parts(job_id: str, take_id: str) -> dict[str, Any]:
    _job, folder = _take_or_404(job_id, take_id)
    state = await asyncio.to_thread(_read_json, folder / _STATE_FILE)
    return {
        **{
            kind: {
                "next_seq": int((state.get(kind) or {}).get("next_seq", 0)),
                "bytes": int((state.get(kind) or {}).get("bytes", 0)),
            }
            for kind in _PART_KINDS
        },
        "finished": bool(state.get("finished")),
    }


# ---------------------------------------------------------------------------
# Finish: the sidecar


def _finite(lo: float, hi: float, default: float | None = None) -> Any:
    return Field(default=default, ge=lo, le=hi, allow_inf_nan=False)


class TimelineModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    first_sample_song_sec: float = Field(ge=-600, le=86_400, allow_inf_nan=False)
    start_song_sec: float | None = _finite(-86_400, 86_400)
    end_song_sec: float | None = _finite(-86_400, 86_400)
    tempo: float = _finite(0.01, 100, 1.0)
    count_in_sec: float | None = _finite(0, 600)
    ctx_time_at_frame0: float | None = _finite(-1e12, 1e12)
    perf_ms_at_frame0: float | None = _finite(-1e15, 1e15)


class LatencyModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    round_trip_ms: float | None = _finite(-10_000, 10_000)
    source: Literal["calibrated", "estimated"] | None = None
    output_latency_ms: float | None = _finite(-10_000, 10_000)
    base_latency_ms: float | None = _finite(-10_000, 10_000)
    input_latency_ms_reported: float | None = _finite(-10_000, 10_000)
    pipeline_latency_ms: float | None = _finite(-10_000, 10_000)
    user_nudge_ms: float = _finite(-_NUDGE_MAX_MS, _NUDGE_MAX_MS, 0.0)
    drift_ppm: float | None = _finite(-10_000, 10_000)


class CaptureModel(BaseModel):
    model_config = ConfigDict(extra="ignore")
    rate: int = Field(ge=8000, le=192_000)
    channels: Literal[1, 2]
    device_label: str | None = Field(default=None, max_length=200)
    dropped_quanta: int | None = Field(default=None, ge=0, le=10**12)


class VideoModel(BaseModel):
    """The camera block (06-video-recording 5.5). Absent fields take their
    defaults: the browser omits what it did not report."""

    model_config = ConfigDict(extra="ignore")
    file: str | None = Field(default=None, max_length=100)  # ignored, set by the server
    mime: str | None = Field(default=None, max_length=100)
    w: int | None = Field(default=None, ge=1, le=4096)
    h: int | None = Field(default=None, ge=1, le=4096)
    fps_nominal: float | None = _finite(1, 240)
    deviceLabel: str | None = Field(default=None, max_length=200)  # noqa: N815 -- agreed wire name
    cameraOffsetMs: float = _finite(-_CAMERA_OFFSET_MAX_MS, _CAMERA_OFFSET_MAX_MS, 0.0)  # noqa: N815
    mirrorPreview: StrictBool | None = None  # noqa: N815
    startedAtAudioCtx: float | None = _finite(-1e12, 1e12)  # noqa: N815
    startedAtPerf: float | None = _finite(-1e15, 1e15)  # noqa: N815
    firstFrameAtMs: float = _finite(-600_000, 600_000, 0.0)  # noqa: N815
    parts: int | None = Field(default=None, ge=0, le=TAKE_MAX_SEQ + 1)


class FinishBody(BaseModel):
    """take.json, version 1 (05-audio-recording 5.6). id and created_at are
    the server's and ignored when sent."""

    model_config = ConfigDict(extra="ignore")
    v: Literal[1]
    label: str | None = Field(default=None, max_length=_LABEL_MAX * 4)
    timeline: TimelineModel
    latency: LatencyModel = Field(default_factory=LatencyModel)
    capture: CaptureModel
    video: VideoModel | None = None
    session: dict[str, Any] | None = None

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        return _clean_label(v)

    @field_validator("session")
    @classmethod
    def _bounded_session(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        # Agent 7's block: stored, not interpreted here, so only its size and
        # JSON-ness are checked (no NaN, nothing json cannot write back).
        if v is None:
            return v
        try:
            encoded = json.dumps(v, allow_nan=False)
        except (TypeError, ValueError):
            raise ValueError("session must be plain JSON") from None
        if len(encoded.encode("utf-8")) > _SESSION_MAX_BYTES:
            raise ValueError("session block too large")
        return v


@router.post("/{job_id}/takes/{take_id}/finish")
async def finish_take(job_id: str, take_id: str, request: Request) -> dict[str, Any]:
    """Close the take: build audio.raw.wav from the audio parts, name the
    camera file, render audio.wav aligned and padded to the stems, merge its
    peaks, write take.json, and add the lane to the job. Synchronous: a
    5-minute take renders in a second or two."""
    job, folder = _take_or_404(job_id, take_id)
    body: FinishBody = await _parse_body(request, FinishBody)
    if body.timeline.tempo != 1.0:
        raise HTTPException(status_code=422, detail="takes recorded at a tempo other than 1.0")
    frames = await asyncio.to_thread(_song_frames, job_id)
    song_sec = frames / TAKE_RATE
    if body.timeline.first_sample_song_sec > song_sec + 600:
        raise HTTPException(status_code=422, detail="take starts after the song")

    async with _lock_for(job_id, take_id):
        state_path = folder / _STATE_FILE
        state = await asyncio.to_thread(_read_json, state_path)
        if state.get("finished"):
            raise HTTPException(status_code=409, detail="take already finished")
        channels = body.capture.channels
        rate = body.capture.rate
        audio_part = folder / "audio.part"
        raw_wav = folder / "audio.raw.wav"
        camera_part = folder / "camera.part"

        def prepare() -> str | None:
            """Validate every input before changing any file, so a refused
            finish can be corrected and sent again."""
            if audio_part.is_file():
                size = audio_part.stat().st_size
                if size == 0:
                    raise HTTPException(status_code=422, detail="take has no audio")
                if size % (4 * channels):
                    raise HTTPException(
                        status_code=422, detail="audio size does not match the channel count"
                    )
            elif not raw_wav.is_file():
                raise HTTPException(status_code=422, detail="take has no audio")
            camera_ext = None
            # Without the video block the camera file is not used: the
            # frontend sends the block only when every camera part arrived,
            # so a missing one means a file with a hole or an unknown start,
            # which would render out of sync. It is discarded in build().
            if body.video is not None and camera_part.is_file() and camera_part.stat().st_size > 0:
                camera_ext = sniff_container(camera_part)
                if camera_ext is None:
                    raise HTTPException(status_code=422, detail="camera file is not WebM or MP4")
            return camera_ext

        camera_ext = await asyncio.to_thread(prepare)

        sidecar = body.model_dump(exclude_none=True)
        sidecar["id"] = take_id
        sidecar["created_at"] = float(state.get("created_at") or time.time())
        sidecar["label"] = body.label or str(state.get("label") or take_id)
        # The track it was opened on; a take opened before tracks existed, or
        # whose track was deleted meanwhile, gets a new track of its own.
        track_id = str(state.get("track_id") or "")
        if not any(t.get("id") == track_id for t in job.tracks):
            track_id = new_track_id({t["id"] for t in job.tracks})
        sidecar["track_id"] = track_id
        if camera_ext is not None:
            sidecar["video"]["file"] = f"camera.{camera_ext}"
        else:
            sidecar.pop("video", None)
        placement = _placement_sec(sidecar)

        def build() -> None:
            if audio_part.is_file():
                assemble_raw_wav(audio_part, raw_wav, rate, channels)
                audio_part.unlink()
            if camera_ext is not None:
                os.replace(camera_part, folder / f"camera.{camera_ext}")
            else:
                camera_part.unlink(missing_ok=True)
            render_take_audio(raw_wav, folder / "audio.wav", placement, frames, rate, channels)
            _write_json_atomic(folder / _SIDECAR_FILE, sidecar)
            _refresh_peaks(job_id, take_id, folder)
            state["finished"] = True
            _write_json_atomic(state_path, state)

        try:
            await asyncio.to_thread(build)
        except TakeRenderError:
            logger.warning("[%s] take %s render failed", job_id, take_id, exc_info=True)
            raise HTTPException(status_code=500, detail="take render failed") from None

        entry = take_entry(job_id, sidecar, camera_ext is not None)
        _replace_entry(job, entry, take_id, activate=True)
    logger.info("[%s] take %s finished (placement %.3f s)", job_id, take_id, placement)
    return entry


# ---------------------------------------------------------------------------
# Edit, delete


class PatchTakeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str | None = Field(default=None, max_length=_LABEL_MAX * 4)
    user_nudge_ms: float | None = _finite(-_NUDGE_MAX_MS, _NUDGE_MAX_MS)
    camera_offset_ms: float | None = _finite(-_CAMERA_OFFSET_MAX_MS, _CAMERA_OFFSET_MAX_MS)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str | None) -> str | None:
        return _clean_label(v)


@router.patch("/{job_id}/takes/{take_id}")
async def patch_take(job_id: str, take_id: str, request: Request) -> dict[str, Any]:
    """Rename, nudge (re-renders audio.wav from the raw capture), or set the
    camera offset. A changed nudge or offset drops an earlier video render:
    it no longer matches what the user hears."""
    job, folder = _take_or_404(job_id, take_id)
    body: PatchTakeBody = await _parse_body(request, PatchTakeBody)
    if body.label is None and body.user_nudge_ms is None and body.camera_offset_ms is None:
        raise HTTPException(status_code=422, detail="nothing to change")
    if _entry(job, take_id) is None:
        raise HTTPException(status_code=409, detail="take not finished")
    if _render_busy(job_id, take_id):
        raise HTTPException(status_code=409, detail="video render running")

    async with _lock_for(job_id, take_id):
        sidecar = await asyncio.to_thread(_read_json, folder / _SIDECAR_FILE)
        has_camera = await asyncio.to_thread(camera_file, folder)
        if body.camera_offset_ms is not None and has_camera is None:
            raise HTTPException(status_code=422, detail="take has no camera")
        latency = sidecar.setdefault("latency", {})
        old_nudge = float(latency.get("user_nudge_ms") or 0.0)
        video = sidecar.get("video") or {}
        old_offset = float(video.get("cameraOffsetMs") or 0.0)

        if body.label is not None:
            sidecar["label"] = body.label
        nudged = body.user_nudge_ms is not None and body.user_nudge_ms != old_nudge
        if body.user_nudge_ms is not None:
            latency["user_nudge_ms"] = body.user_nudge_ms
        offset_moved = body.camera_offset_ms is not None and body.camera_offset_ms != old_offset
        if body.camera_offset_ms is not None:
            sidecar.setdefault("video", {})["cameraOffsetMs"] = body.camera_offset_ms

        def apply() -> None:
            if nudged:
                frames = _song_frames(job_id)
                capture = sidecar.get("capture") or {}
                render_take_audio(
                    folder / "audio.raw.wav",
                    folder / "audio.wav",
                    _placement_sec(sidecar),
                    frames,
                    int(capture.get("rate") or TAKE_RATE),
                    int(capture.get("channels") or 2),
                )
                _refresh_peaks(job_id, take_id, folder)
            if nudged or offset_moved:
                (folder / _RENDER_FILE).unlink(missing_ok=True)
            _write_json_atomic(folder / _SIDECAR_FILE, sidecar)

        try:
            await asyncio.to_thread(apply)
        except TakeRenderError:
            logger.warning("[%s] take %s re-render failed", job_id, take_id, exc_info=True)
            raise HTTPException(status_code=500, detail="take render failed") from None
        if nudged or offset_moved:
            _renders.pop((job_id, take_id), None)
        entry = take_entry(job_id, sidecar, has_camera is not None)
        _replace_entry(job, entry, take_id)
    return entry


@router.delete("/{job_id}/takes/{take_id}")
async def delete_take(job_id: str, take_id: str) -> dict[str, str]:
    """Remove a take, finished or not: folder, lane and waveform."""
    job, folder = _take_or_404(job_id, take_id)
    if _render_busy(job_id, take_id):
        raise HTTPException(status_code=409, detail="video render running")
    async with _lock_for(job_id, take_id):
        removed = await asyncio.to_thread(_remove_take_folder, job_id, take_id, folder)
        _renders.pop((job_id, take_id), None)
        if _entry(job, take_id) is not None:
            _replace_entry(job, None, take_id)
    _take_locks.pop(f"{job_id}/{take_id}", None)
    if not removed:
        raise HTTPException(status_code=500, detail="take files could not be deleted")
    return {"take_id": take_id, "status": "deleted"}


def _remove_take_folder(job_id: str, take_id: str, folder: Path) -> bool:
    """Blocking. Retried briefly: on Windows a render ffmpeg that was just
    killed can hold camera.* open for a moment after it exits."""
    for attempt in range(10):
        try:
            shutil.rmtree(folder)
            break
        except FileNotFoundError:
            break
        except OSError:
            if attempt == 9:
                logger.warning("could not remove take %s", folder, exc_info=True)
            time.sleep(0.2)
    _refresh_peaks(job_id, take_id, folder, remove=True)
    return not folder.exists()


# ---------------------------------------------------------------------------
# Tracks


class TrackInput(BaseModel):
    """Which input a track records from. Only stored for the UI: capture runs
    in the browser and the take's sidecar says what was actually captured."""

    model_config = ConfigDict(extra="forbid")
    device_id: str | None = Field(default=None, max_length=256)
    device_label: str | None = Field(default=None, max_length=200)
    channels: list[int] = Field(min_length=1, max_length=2)

    @field_validator("channels")
    @classmethod
    def _channels(cls, v: list[int]) -> list[int]:
        if any(isinstance(c, bool) or not 0 <= c <= 63 for c in v):
            raise ValueError("channel index must be 0..63")
        if len(set(v)) != len(v):
            raise ValueError("a stereo pair needs two different channels")
        return v

    @field_validator("device_id", "device_label")
    @classmethod
    def _printable(cls, v: str | None) -> str | None:
        if v is not None and _CONTROL_CHARS.search(v):
            raise ValueError("must be printable")
        return v


class CreateTrackBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, max_length=_LABEL_MAX * 4)
    input: TrackInput | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return _clean_label(v)


class PatchTrackBody(CreateTrackBody):
    active_take_id: str | None = Field(default=None, max_length=16)
    order: int | None = Field(default=None, ge=0, le=TRACK_MAX_PER_JOB)


def _track_view(job: Job, track_id: str) -> dict[str, Any]:
    return next(t for t in job.tracks if t["id"] == track_id)


@router.post("/{job_id}/tracks", status_code=201)
async def create_track(job_id: str, request: Request) -> dict[str, Any]:
    """Add a recording track: {} or {"name"?, "input"?}."""
    job = _job_or_404(job_id)
    root = (JOBS_DIR / job_id / TAKES_DIRNAME).resolve()
    if not root.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")
    body = await _parse_body(request, CreateTrackBody, empty_ok=True)
    # No await from here to the commit: see _commit.
    if len(job.tracks) >= TRACK_MAX_PER_JOB:
        raise HTTPException(status_code=409, detail="too many tracks for this song")
    used = {t["id"] for t in job.tracks}
    track_id = new_track_id(used)
    names = {t.get("name") for t in job.tracks}
    n = len(job.tracks) + 1
    while f"Track {n}" in names:
        n += 1
    track = make_track(
        track_id,
        body.name or f"Track {n}",
        len(job.tracks),
        body.input.model_dump() if body.input else None,
    )
    _commit(job, list(job.takes), [*job.tracks, track])
    logger.info("[%s] track %s created", job_id, track_id)
    return _track_view(job, track_id)


@router.patch("/{job_id}/tracks/{track_id}")
async def patch_track(job_id: str, track_id: str, request: Request) -> dict[str, Any]:
    """Rename, set the input (null clears it), switch the active take, or
    move the track to another position."""
    job = _job_or_404(job_id)
    _track_or_404(job, track_id)
    body = await _parse_body(request, PatchTrackBody)
    fields = body.model_fields_set
    if not fields:
        raise HTTPException(status_code=422, detail="nothing to change")
    # Re-read after the await, then no await until the commit.
    track = dict(_track_or_404(job, track_id))
    if "name" in fields:
        if body.name is None:
            raise HTTPException(status_code=422, detail="name cannot be empty")
        track["name"] = body.name
    if "input" in fields:
        track["input"] = body.input.model_dump() if body.input else None
    if "active_take_id" in fields:
        take = next(
            (
                t
                for t in job.takes
                if t.get("id") == body.active_take_id and t.get("track_id") == track_id
            ),
            None,
        )
        if take is None:
            raise HTTPException(status_code=422, detail="not a finished take of this track")
        track["active_take_id"] = take["id"]
    others = [dict(t) for t in job.tracks if t["id"] != track_id]
    position = track["order"]
    if "order" in fields and body.order is not None:
        position = min(body.order, len(others))
    others.insert(position, track)
    for i, t in enumerate(others):
        t["order"] = i
    _commit(job, list(job.takes), others)
    return _track_view(job, track_id)


@router.delete("/{job_id}/tracks/{track_id}")
async def delete_track(job_id: str, track_id: str) -> dict[str, Any]:
    """Delete a track and every take on it, finished or not, stopping any
    video render of them first."""
    job = _job_or_404(job_id)
    _track_or_404(job, track_id)
    root = (JOBS_DIR / job_id / TAKES_DIRNAME).resolve()
    if not root.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")

    def owned() -> list[str]:
        ids = {t["id"] for t in job.takes if t.get("track_id") == track_id}
        if root.is_dir():
            for folder in root.iterdir():
                if not folder.is_dir() or not TAKE_ID_RE.match(folder.name):
                    continue
                state = folder / _STATE_FILE
                try:
                    if json.loads(state.read_text(encoding="utf-8")).get("track_id") == track_id:
                        ids.add(folder.name)
                except (OSError, ValueError, AttributeError):
                    continue
        return sorted(ids)

    take_ids = await asyncio.to_thread(owned)
    # The track goes first, so a take finishing meanwhile cannot make it
    # active again; its takes follow.
    _commit(
        job,
        [t for t in job.takes if t.get("id") not in take_ids],
        [t for t in job.tracks if t["id"] != track_id],
    )
    failed = False
    for take_id in take_ids:
        run = _renders.pop((job_id, take_id), None)
        if run is not None:
            _stop_run(run)
        folder = take_dir(job_id, take_id, JOBS_DIR)
        if folder is None:
            continue
        async with _lock_for(job_id, take_id):
            if not await asyncio.to_thread(_remove_take_folder, job_id, take_id, folder):
                failed = True
        _take_locks.pop(f"{job_id}/{take_id}", None)
    if any(t.get("id") in take_ids for t in job.takes):
        _commit(job, [t for t in job.takes if t.get("id") not in take_ids], list(job.tracks))
    logger.info("[%s] track %s deleted with %d takes", job_id, track_id, len(take_ids))
    if failed:
        raise HTTPException(status_code=500, detail="take files could not be deleted")
    return {"track_id": track_id, "status": "deleted", "takes_deleted": take_ids}


# ---------------------------------------------------------------------------
# Serve


def _download_name(job: Job, label: str, ext: str) -> str:
    parts = [p for p in (stems_api._title_slug(job.title), stems_api._title_slug(label)) if p]
    return f"{'_'.join(parts) or 'take'}.{ext}"


@router.api_route(
    "/{job_id}/takes/{take_id}/audio.wav", methods=["GET", "HEAD"], response_model=None
)
async def get_take_audio(job_id: str, take_id: str) -> FileResponse:
    job, folder, entry = _finished_or_404(job_id, take_id)
    path = (folder / "audio.wav").resolve()
    if not path.is_file() or not path.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="take not found")
    return FileResponse(
        path, media_type="audio/wav", filename=_download_name(job, entry["label"], "wav")
    )


@router.get("/{job_id}/takes/{take_id}/camera", response_model=None)
async def get_take_camera(job_id: str, take_id: str) -> FileResponse:
    _job, folder, _entry_ = _finished_or_404(job_id, take_id)
    path = camera_file(folder)
    if path is None or not path.resolve().is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="take has no camera")
    media = "video/webm" if path.suffix == ".webm" else "video/mp4"
    return FileResponse(path.resolve(), media_type=media)


# ---------------------------------------------------------------------------
# Video render


@dataclass
class _RenderRun:
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    proc: subprocess.Popen | None = None


_renders: dict[tuple[str, str], _RenderRun] = {}
_render_tasks: set[asyncio.Task] = set()


def _render_busy(job_id: str, take_id: str) -> bool:
    run = _renders.get((job_id, take_id))
    return run is not None and run.status in ("queued", "running")


def _stop_run(run: _RenderRun) -> None:
    run.cancel.set()
    proc = run.proc
    if proc is not None and proc.poll() is None:
        proc.kill()


def cancel_job_renders(job_id: str) -> None:
    """Stop every render of a job, for the job's deletion: its folder is
    about to go, and on Windows a running ffmpeg would hold files open."""
    for (jid, tid), run in list(_renders.items()):
        if jid == job_id:
            _stop_run(run)
            _renders.pop((jid, tid), None)


def _render_view(job_id: str, take_id: str, folder: Path) -> dict[str, Any]:
    run = _renders.get((job_id, take_id))
    url = f"/api/jobs/{job_id}/takes/{take_id}/render.mp4"
    if run is not None and run.status != "done":
        return {"status": run.status, "progress": run.progress, "error": run.error, "url": None}
    if (folder / _RENDER_FILE).is_file():
        return {"status": "done", "progress": 1.0, "error": None, "url": url}
    return {"status": "none", "progress": 0.0, "error": None, "url": None}


class RenderBody(BaseModel):
    """Single-tile subset of the layout descriptor (06-video-recording 5.3)."""

    model_config = ConfigDict(extra="forbid")
    stems: list[str] = Field(default_factory=list, max_length=_RENDER_MAX_LANES)
    gains: list[float] = Field(default_factory=list, max_length=_RENDER_MAX_LANES)
    pitches: list[int] | None = Field(default=None, max_length=_RENDER_MAX_LANES)
    take_gain: float = Field(default=1.0, ge=0, le=4, allow_inf_nan=False)
    camera_offset_ms: float | None = _finite(-_CAMERA_OFFSET_MAX_MS, _CAMERA_OFFSET_MAX_MS)
    canvas: Literal["16:9", "9:16"] = "16:9"
    fit: Literal["cover", "contain"] = "cover"
    mirror: StrictBool = False

    @field_validator("stems")
    @classmethod
    def _names(cls, v: list[str]) -> list[str]:
        for name in v:
            if len(name) > 32:
                raise ValueError("unknown stem requested")
        return v


def _render_lanes(job_id: str, take_id: str, body: RenderBody) -> list[AudioLane]:
    """Validate and resolve the backing lanes with the export's own rules."""
    if len(body.gains) != len(body.stems):
        raise HTTPException(status_code=422, detail="stems and gains must be equal length")
    if any(not (0 <= g <= stems_api._MIXDOWN_MAX_GAIN) for g in body.gains):
        raise HTTPException(status_code=422, detail="gain out of range")
    active = {t["id"]: t.get("active_take_id") for t in registry_get(job_id).tracks}
    if take_id in body.stems or any(active.get(n) == take_id for n in body.stems):
        raise HTTPException(status_code=422, detail="the take is already in the video")
    if not body.stems:
        return []
    if len(set(body.stems)) != len(body.stems):
        raise HTTPException(status_code=422, detail="a lane is listed twice")
    names, gains = stems_api._parse_lane_gains(
        ",".join(body.stems), ",".join(f"{g:.6f}" for g in body.gains)
    )
    pitches = stems_api._parse_pitches(
        ",".join(str(p) for p in body.pitches) if body.pitches else "", names
    )
    if any(pitches) and not stems_api._rubberband_available():
        raise HTTPException(
            status_code=422, detail="this ffmpeg build cannot transpose (no rubberband filter)"
        )
    lanes, _unpitched = stems_api._expand_render_lanes(job_id, names, gains, pitches)
    return [AudioLane(lane.path, lane.gain, stems_api._pitch_filter(lane.pitch)) for lane in lanes]


async def _render_task(
    run: _RenderRun, job: Job, cmd: list[str], dest: Path, duration: float
) -> None:
    def cancelled() -> bool:
        return run.cancel.is_set() or registry_get(job.id) is not job

    def report(share: float) -> None:
        run.progress = share

    def on_proc(proc: subprocess.Popen | None) -> None:
        run.proc = proc

    try:
        # Behind the pipeline lock like every other heavy on-demand run: an
        # x264 encode and a Demucs pass on the same CPU slow each other down
        # for no gain. "queued" until an import in progress has finished.
        async with _pipeline_lock:
            if cancelled():
                raise RenderCancelled()
            run.status = "running"
            await asyncio.to_thread(
                run_video_render,
                cmd,
                dest,
                duration,
                cancelled=cancelled,
                report=report,
                on_proc=on_proc,
                timeout=TIMEOUT_VIDEO_RENDER,
            )
        run.status = "done"
        run.progress = 1.0
    except RenderCancelled:
        run.status = "none"
    except TakeRenderError:
        logger.warning("[%s] video render failed", job.id, exc_info=True)
        run.status = "error"
        run.error = "video render failed"
    except Exception:
        logger.exception("[%s] video render failed", job.id)
        run.status = "error"
        run.error = "video render failed"


@router.post("/{job_id}/takes/{take_id}/render", status_code=202)
async def start_render(job_id: str, take_id: str, request: Request) -> JSONResponse:
    """Render the take's camera over the backing mix plus the take to MP4,
    in the background: 202, then GET .../render follows it."""
    job, folder, entry = _finished_or_404(job_id, take_id)
    body: RenderBody = await _parse_body(request, RenderBody, empty_ok=True)
    camera = await asyncio.to_thread(camera_file, folder)
    if camera is None:
        raise HTTPException(status_code=404, detail="take has no camera")
    if not await asyncio.to_thread(libx264_available):
        raise HTTPException(
            status_code=422, detail="this ffmpeg build cannot encode H.264 video (no libx264)"
        )
    if not await asyncio.to_thread(aac_available):
        raise HTTPException(
            status_code=422, detail="this ffmpeg build cannot encode H.264 video (no AAC encoder)"
        )
    lanes = await asyncio.to_thread(_render_lanes, job_id, take_id, body)
    if _render_busy(job_id, take_id):
        raise HTTPException(status_code=409, detail="video render already running")

    sidecar = await asyncio.to_thread(_read_json, folder / _SIDECAR_FILE)
    video = sidecar.get("video") or {}
    offset_ms = (
        body.camera_offset_ms
        if body.camera_offset_ms is not None
        else float(video.get("cameraOffsetMs") or 0.0)
    )
    camera_start = (
        _placement_sec(sidecar) + float(video.get("firstFrameAtMs") or 0.0) / 1000.0
    ) - offset_ms / 1000.0
    frames = await asyncio.to_thread(_song_frames, job_id)
    duration = frames / TAKE_RATE
    cmd = build_video_render_cmd(
        lanes,
        folder / "audio.wav",
        body.take_gain,
        camera,
        camera_start,
        duration,
        body.canvas,
        body.fit,
        body.mirror,
        get_export_sample_rate(),
    )
    run = _RenderRun()
    _renders[(job_id, take_id)] = run
    task = asyncio.create_task(_render_task(run, job, cmd, folder / _RENDER_FILE, duration))
    _render_tasks.add(task)
    task.add_done_callback(_render_tasks.discard)
    logger.info("[%s] take %s video render queued (%d lanes)", job_id, take_id, len(lanes))
    return JSONResponse(_render_view(job_id, take_id, folder), status_code=202)


@router.get("/{job_id}/takes/{take_id}/render")
async def get_render(job_id: str, take_id: str) -> dict[str, Any]:
    _job, folder, _entry_ = _finished_or_404(job_id, take_id)
    return _render_view(job_id, take_id, folder)


@router.post("/{job_id}/takes/{take_id}/render/cancel")
async def cancel_render(job_id: str, take_id: str) -> dict[str, Any]:
    _job, folder, _entry_ = _finished_or_404(job_id, take_id)
    run = _renders.pop((job_id, take_id), None)
    if run is not None:
        _stop_run(run)
    return _render_view(job_id, take_id, folder)


@router.get("/{job_id}/takes/{take_id}/render.mp4", response_model=None)
async def get_render_file(job_id: str, take_id: str) -> FileResponse:
    job, folder, entry = _finished_or_404(job_id, take_id)
    path = (folder / _RENDER_FILE).resolve()
    if not path.is_file() or not path.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="no video render")
    return FileResponse(
        path, media_type="video/mp4", filename=_download_name(job, entry["label"], "mp4")
    )
