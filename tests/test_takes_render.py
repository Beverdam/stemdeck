"""Video render of a take: camera tile + backing mix + take audio -> MP4.

The end-to-end tests run the real ffmpeg on a white camera clip and read
frames back, so they check placement and the offset sign, not just that a
file appeared.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import time

import httpx
import numpy as np
import pytest
import soundfile as sf

from app.api import stems as stems_mod
from app.api import takes as takes_mod
from app.core.config import ffmpeg_executable, ffprobe_executable
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import take_render
from app.pipeline.take_render import AudioLane, build_video_render_cmd, camera_filter
from tests.ffmpeg_probe import skip_without_ffmpeg

JOB = "abcdefabcdef"
SR = 44100
SONG_SEC = 3.0


def _app():
    from app.main import app

    return app


@pytest.fixture
def jobs_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(stems_mod, "_MIXDOWN_CACHE_DIR", tmp_path / "cache" / "mixdown")
    from app.core import config

    takes_mod._renders.clear()
    return config.JOBS_DIR


@pytest.fixture
def client(jobs_dir):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app()), base_url="http://testserver"
    )


def _make_job(jobs_dir) -> Job:
    job = Job(id=JOB, status="done", title="Song", duration_sec=SONG_SEC)
    _jobs[job.id] = job
    stems = jobs_dir / JOB / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(SR * SONG_SEC)) / SR
    for name in ("vocals", "drums"):
        x = 0.2 * np.sin(2 * np.pi * 440 * t)
        sf.write(stems / f"{name}.wav", np.stack([x, x], 1), SR, subtype="PCM_16")
    return job


def _white_camera(path, seconds=1.0, container="mp4") -> bytes:
    """A white 1 s clip. WebM is written to a pipe, as MediaRecorder writes
    it: no seek-back, so no duration, no cues and clusters of unknown size."""
    if container == "webm":
        out = subprocess.run(
            [
                ffmpeg_executable(),
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"color=c=white:s=320x240:r=30:d={seconds}",
                "-c:v",
                "libvpx",
                "-f",
                "webm",
                "pipe:1",
            ],
            capture_output=True,
            check=True,
            timeout=60,
        ).stdout
        path.write_bytes(out)
        return out
    subprocess.run(
        [
            ffmpeg_executable(),
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=white:s=320x240:r=30:d={seconds}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        timeout=60,
    )
    return path.read_bytes()


async def _take_with_camera(
    c, tmp_path, first_frame_ms=1000.0, camera_offset_ms=0.0, container="mp4"
) -> str:
    track = (await c.post(f"/api/jobs/{JOB}/tracks", json={})).json()["id"]
    r = await c.post(f"/api/jobs/{JOB}/takes", json={"track_id": track})
    tid = r.json()["take_id"]
    audio = np.zeros((48000, 1), dtype="<f4").tobytes()
    assert (
        await c.put(f"/api/jobs/{JOB}/takes/{tid}/parts/audio?seq=0", content=audio)
    ).status_code == 200
    cam = _white_camera(tmp_path / f"cam.{container}", container=container)
    assert (
        await c.put(f"/api/jobs/{JOB}/takes/{tid}/parts/camera?seq=0", content=cam)
    ).status_code == 200
    body = {
        "v": 1,
        "timeline": {"first_sample_song_sec": 0.0, "tempo": 1.0},
        "capture": {"rate": 48000, "channels": 1},
        "video": {
            "mime": f"video/{container}",
            "firstFrameAtMs": first_frame_ms,
            "cameraOffsetMs": camera_offset_ms,
        },
    }
    r = await c.post(f"/api/jobs/{JOB}/takes/{tid}/finish", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["has_camera"] is True
    return tid


async def _wait(c, tid, timeout=180.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        view = (await c.get(f"/api/jobs/{JOB}/takes/{tid}/render")).json()
        if view["status"] in ("done", "error", "none"):
            return view
        await asyncio.sleep(0.2)
    raise AssertionError("render did not finish")


def _brightness(path, t: float) -> float:
    out = subprocess.run(
        [
            ffmpeg_executable(),
            "-nostdin",
            "-loglevel",
            "error",
            "-ss",
            f"{t}",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            "scale=16:16,format=gray",
            "-f",
            "rawvideo",
            "pipe:1",
        ],
        capture_output=True,
        check=True,
        timeout=60,
    ).stdout
    return float(np.frombuffer(out, dtype=np.uint8).mean())


def _probe(path) -> dict:
    out = subprocess.run(
        [
            ffprobe_executable(),
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        check=True,
        timeout=60,
    ).stdout
    return json.loads(out)


def _needs_x264():
    skip_without_ffmpeg()
    take_render._encoders_cached = None
    if not take_render.libx264_available():
        pytest.skip("this ffmpeg has no libx264")


# ─── Command builder (pure) ──────────────────────────────────────────────


def test_command_has_the_agreed_encode_settings(tmp_path):
    cmd = build_video_render_cmd(
        [AudioLane(tmp_path / "drums.wav", 1.0, "")],
        tmp_path / "audio.wav",
        0.8,
        tmp_path / "camera.webm",
        0.5,
        3.0,
        "16:9",
        "cover",
        False,
        44100,
    )
    joined = " ".join(cmd)
    for part in ("-c:v libx264", "-crf 20", "-pix_fmt yuv420p", "-r 30", "-c:a aac", "+faststart"):
        assert part in joined
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "amix=inputs=2:normalize=0,alimiter" in graph
    assert "[1:a]volume=0.800000[a1]" in graph
    assert "s=1920x1080" in graph and "overlay=eof_action=pass" in graph
    assert cmd[cmd.index("-t") + 1] == "3.000000"


def test_camera_filter_places_and_fits():
    late = camera_filter(1.25, 1080, 1920, "contain", True, "[2:v]")
    assert "setpts=PTS-STARTPTS+1.250000/TB" in late
    assert "pad=1080:1920" in late and "hflip" in late
    early = camera_filter(-0.5, 1920, 1080, "cover", False, "[2:v]")
    assert "trim=start=0.500000" in early and "crop=1920:1080" in early
    assert "hflip" not in early


# ─── Endpoint ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("container", ["mp4", "webm"])
async def test_render_places_the_camera_and_writes_a_faststart_mp4(
    jobs_dir, client, tmp_path, container
):
    """Camera frame 0 at song 1.0 s (firstFrameAtMs), offset +500 ms (video
    late, subtract): the white clip shows from 0.5 s to 1.5 s, black around
    it, and the file is the song's length."""
    _needs_x264()
    _make_job(jobs_dir)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path, first_frame_ms=1000.0, container=container)
        assert (jobs_dir / JOB / "takes" / tid / f"camera.{container}").is_file()
        r = await c.post(
            f"/api/jobs/{JOB}/takes/{tid}/render",
            json={"stems": ["drums"], "gains": [1.0], "camera_offset_ms": 500},
        )
        assert r.status_code == 202, r.text
        assert r.json()["status"] in ("queued", "running")
        view = await _wait(c, tid)
        assert view == {
            "status": "done",
            "progress": 1.0,
            "error": None,
            "url": f"/api/jobs/{JOB}/takes/{tid}/render.mp4",
        }
        dl = await c.get(view["url"])
    assert dl.status_code == 200 and dl.headers["content-type"] == "video/mp4"
    out = jobs_dir / JOB / "takes" / tid / "render.mp4"
    info = _probe(out)
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    audio = next(s for s in info["streams"] if s["codec_type"] == "audio")
    assert (video["codec_name"], video["pix_fmt"], video["width"], video["height"]) == (
        "h264",
        "yuv420p",
        1920,
        1080,
    )
    assert video["r_frame_rate"] == "30/1"
    assert audio["codec_name"] == "aac"
    assert abs(float(info["format"]["duration"]) - SONG_SEC) < 0.1
    data = out.read_bytes()
    assert 0 <= data.find(b"moov") < data.find(b"mdat")  # +faststart
    assert _brightness(out, 0.25) < 20
    assert _brightness(out, 1.0) > 200
    assert _brightness(out, 2.5) < 20


async def test_render_uses_the_stored_offset_and_portrait_canvas(jobs_dir, client, tmp_path):
    _needs_x264()
    _make_job(jobs_dir)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path, first_frame_ms=0.0, camera_offset_ms=0.0)
        r = await c.patch(f"/api/jobs/{JOB}/takes/{tid}", json={"camera_offset_ms": -1500})
        assert r.json()["camera_offset_ms"] == -1500
        r = await c.post(f"/api/jobs/{JOB}/takes/{tid}/render", json={"canvas": "9:16"})
        assert r.status_code == 202, r.text
        assert (await _wait(c, tid))["status"] == "done"
    out = jobs_dir / JOB / "takes" / tid / "render.mp4"
    video = next(s for s in _probe(out)["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (1080, 1920)
    # Offset -1500 ms: the camera was early, so it is shown 1.5 s later.
    assert _brightness(out, 1.0) < 20
    assert _brightness(out, 2.0) > 200


async def test_render_refusals(jobs_dir, client, tmp_path, monkeypatch):
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    async with client as c:
        track = (await c.post(f"/api/jobs/{JOB}/tracks", json={})).json()["id"]
        r = await c.post(f"/api/jobs/{JOB}/takes", json={"track_id": track})
        plain = r.json()["take_id"]
        await c.put(
            f"/api/jobs/{JOB}/takes/{plain}/parts/audio?seq=0",
            content=np.zeros(4800, dtype="<f4").tobytes(),
        )
        body = {
            "v": 1,
            "timeline": {"first_sample_song_sec": 0.0},
            "capture": {"rate": 48000, "channels": 1},
        }
        await c.post(f"/api/jobs/{JOB}/takes/{plain}/finish", json=body)
        base = f"/api/jobs/{JOB}/takes/{plain}/render"
        assert (await c.post(base, json={})).status_code == 404  # no camera
        assert (await c.get(base)).json()["status"] == "none"
        assert (await c.get(f"{base}.mp4")).status_code == 404
        assert (
            await c.post("/api/jobs/000000000000/takes/t00000000/render", json={})
        ).status_code == 404

        monkeypatch.setattr(takes_mod, "camera_file", lambda folder: folder / "audio.wav")
        bad = [
            {"stems": ["drums"], "gains": []},
            {"stems": ["drums"], "gains": [9]},
            {"stems": ["nope"], "gains": [1]},
            {"stems": [plain], "gains": [1]},
            {"stems": ["vocals", "lead_vocals"], "gains": [1, 1]},
            {"canvas": "4:3"},
            {"fit": "stretch"},
            {"mirror": "yes"},
            {"camera_offset_ms": 6000},
            {"unknown": 1},
        ]
        monkeypatch.setattr(takes_mod, "libx264_available", lambda: True)
        monkeypatch.setattr(takes_mod, "aac_available", lambda: True)
        for payload in bad:
            r = await c.post(base, json=payload)
            assert r.status_code == 422, (payload, r.text)
        r = await c.post(
            base, content=b'{"take_gain": NaN}', headers={"content-type": "application/json"}
        )
        assert r.status_code == 422

        monkeypatch.setattr(takes_mod, "libx264_available", lambda: False)
        r = await c.post(base, json={})
        assert r.status_code == 422 and "libx264" in r.json()["detail"]


async def test_a_running_render_blocks_a_second_one_edit_and_delete(jobs_dir, client, tmp_path):
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path)
        run = takes_mod._RenderRun(status="running")
        takes_mod._renders[(JOB, tid)] = run
        base = f"/api/jobs/{JOB}/takes/{tid}"
        assert (await c.patch(base, json={"label": "x"})).status_code == 409
        assert (await c.delete(base)).status_code == 409
        if take_render.libx264_available():
            assert (await c.post(f"{base}/render", json={})).status_code == 409
        r = await c.post(f"{base}/render/cancel")
        assert r.json()["status"] == "none"
        assert run.cancel.is_set()
        assert (await c.delete(base)).status_code == 200


def test_deleting_a_job_stops_its_renders():
    run = takes_mod._RenderRun(status="running")
    other = takes_mod._RenderRun(status="running")
    takes_mod._renders[(JOB, "t00000001")] = run
    takes_mod._renders[("bbbbbbbbbbbb", "t00000001")] = other
    takes_mod.cancel_job_renders(JOB)
    assert run.cancel.is_set() and not other.cancel.is_set()
    assert (JOB, "t00000001") not in takes_mod._renders
    takes_mod._renders.clear()


async def test_cancel_stops_a_real_render(jobs_dir, client, tmp_path, monkeypatch):
    _needs_x264()
    _make_job(jobs_dir)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path)
        r = await c.post(f"/api/jobs/{JOB}/takes/{tid}/render", json={})
        assert r.status_code == 202
        await c.post(f"/api/jobs/{JOB}/takes/{tid}/render/cancel")
        await asyncio.sleep(1.5)
        assert (await c.get(f"/api/jobs/{JOB}/takes/{tid}/render")).json()["status"] in (
            "none",
            "done",  # a 3 s render on a fast machine can win the race
        )
    leftovers = list((jobs_dir / JOB / "takes" / tid).glob(".render.mp4.*"))
    assert leftovers == []
