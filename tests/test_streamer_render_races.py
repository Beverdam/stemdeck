"""Streamer Mode export, the fix pass: a render's races and edges.

Cancel kills the ffmpeg process and never reports an older file as done; a
take deleted while it renders stops the render; a cancel that lands while the
render is still being prepared starts nothing; a trim outside the take is
refused; a render's file is not served while a new one is made; a failed
encoder probe is not cached; stale temp files are swept at startup; a failed
cover fetch is retried after a pause; an over-long ?name= is refused.
"""

from __future__ import annotations

import asyncio
import subprocess
import time

import httpx
import pytest

from app.api import cover as cover_mod
from app.api import stems as stems_mod
from app.api import takes as takes_mod
from app.pipeline import take_render
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_takes_render import JOB, _make_job, _needs_x264, _sidecar, _take_with_camera


def _app():
    from app.main import app

    return app


@pytest.fixture
def jobs_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(stems_mod, "_MIXDOWN_CACHE_DIR", tmp_path / "cache" / "mixdown")
    from app.core import config

    takes_mod._renders.clear()
    cover_mod._failed_at.clear()
    return config.JOBS_DIR


@pytest.fixture
def client(jobs_dir):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app()), base_url="http://testserver"
    )


# A long render (the whole 4K song) to have a running ffmpeg to act on.
_SLOW = {"canvas": "16:9", "fit": "fill", "size": "2160", "fps": 30, "span": "song"}


async def _running_proc(tid: str, timeout: float = 30.0) -> subprocess.Popen:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        run = takes_mod._renders.get((JOB, tid))
        if run is not None and run.proc is not None:
            return run.proc
        await asyncio.sleep(0.05)
    raise AssertionError("the render never started its ffmpeg")


async def test_cancel_kills_ffmpeg_and_never_reports_an_old_file(jobs_dir, client, tmp_path):
    _needs_x264()
    _make_job(jobs_dir)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path)
        folder = jobs_dir / JOB / "takes" / tid
        # A render from an earlier export is there.
        (folder / "render.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42old")
        url = f"/api/jobs/{JOB}/takes/{tid}/render"
        assert (await c.post(url, json=_SLOW)).status_code == 202
        assert not (folder / "render.mp4").exists(), "the old file goes when a render starts"
        proc = await _running_proc(tid)
        # While it renders, its file is not served (half a new one, or the old).
        r = await c.get(f"{url}.mp4")
        assert r.status_code == 409
        await c.post(f"{url}/cancel")
        deadline = time.monotonic() + 10
        while proc.poll() is None and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        assert proc.poll() is not None, "cancel killed the ffmpeg process"
        await asyncio.sleep(0.3)
        view = (await c.get(url)).json()
        assert view["status"] == "none" and view["url"] is None
    assert list(folder.glob(".render.mp4.*")) == []


async def test_deleting_a_take_while_it_renders_stops_the_render(jobs_dir, client, tmp_path):
    _needs_x264()
    _make_job(jobs_dir)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path)
        url = f"/api/jobs/{JOB}/takes/{tid}"
        assert (await c.post(f"{url}/render", json=_SLOW)).status_code == 202
        proc = await _running_proc(tid)
        r = await c.delete(url)
        assert r.status_code == 200, r.text
        assert proc.poll() is not None, "the render's ffmpeg was stopped and waited for"
        assert (JOB, tid) not in takes_mod._renders
        assert not (jobs_dir / JOB / "takes" / tid).exists()


async def test_a_cancel_while_the_render_is_prepared_starts_nothing(
    jobs_dir, client, tmp_path, monkeypatch
):
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    monkeypatch.setattr(takes_mod, "libx264_available", lambda: True)
    monkeypatch.setattr(takes_mod, "aac_available", lambda: True)
    started = []
    real_prepare = takes_mod._prepare_render

    async def slow_prepare(*a, **k):
        await asyncio.sleep(0.4)
        return await real_prepare(*a, **k)

    async def fake_task(run, job, cmd, dest, duration, retry=None):
        started.append(cmd)

    monkeypatch.setattr(takes_mod, "_prepare_render", slow_prepare)
    monkeypatch.setattr(takes_mod, "_render_task", fake_task)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path)
        url = f"/api/jobs/{JOB}/takes/{tid}/render"

        async def cancel_soon():
            await asyncio.sleep(0.1)
            return await c.post(f"{url}/cancel")

        posted, cancelled = await asyncio.gather(c.post(url, json={}), cancel_soon())
        assert posted.status_code == 202 and cancelled.status_code == 200
        await asyncio.sleep(0.1)
        assert started == [], "nothing renders after a cancel that came first"
        assert (await c.get(url)).json()["status"] == "none"


def test_a_trim_outside_the_take_is_refused():
    side = _sidecar(10.0, start=10.0, end=20.0)
    outside = takes_mod._range_outside_take
    assert outside(side, 60.0, 0.0, 9.0), "wholly before the take"
    assert outside(side, 60.0, 0.0, 10.0), "ending where the take starts"
    assert outside(side, 60.0, 21.0, 30.0), "wholly after it"
    assert not outside(side, 60.0, 5.0, 12.0), "overlapping its start"
    assert not outside(side, 60.0, 12.0, 18.0), "inside it"


async def test_a_trim_outside_the_take_gets_422(jobs_dir, client, tmp_path, monkeypatch):
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    monkeypatch.setattr(takes_mod, "libx264_available", lambda: True)
    monkeypatch.setattr(takes_mod, "aac_available", lambda: True)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path)
        r = await c.post(
            f"/api/jobs/{JOB}/takes/{tid}/render",
            json={"fit": "fill", "span": "range", "range_in": 200.0, "range_out": 201.0},
        )
        assert r.status_code == 422
        assert "outside" in r.json()["detail"]
        assert (JOB, tid) not in takes_mod._renders


async def test_an_over_long_download_name_is_refused(jobs_dir, client, tmp_path):
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    async with client as c:
        tid = await _take_with_camera(c, tmp_path)
        folder = jobs_dir / JOB / "takes" / tid
        (folder / "render.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
        base = f"/api/jobs/{JOB}/takes/{tid}/render.mp4"
        r = await c.get(base, params={"name": "x" * 201 + ".mp4"})
        assert r.status_code == 422
        r = await c.get(base, params={"name": "y" * 170 + ".mp4"})
        assert r.status_code == 200 and "y" * 170 not in r.headers["content-disposition"]


def test_a_failed_encoder_probe_is_not_cached(monkeypatch):
    calls = []

    def failing(*a, **k):
        calls.append(a[0])
        raise subprocess.TimeoutExpired(a[0], 10)

    monkeypatch.setattr(take_render, "_encoders_cached", None)
    monkeypatch.setattr(take_render.subprocess, "run", failing)
    assert take_render._encoders() == ""
    assert take_render._encoders() == ""
    assert len(calls) == 2, "probed again after a failure"
    assert "-nostdin" in calls[0]

    class Done:
        returncode = 0
        stdout = " V..... libx264  H.264\n A..... aac  AAC\n"

    monkeypatch.setattr(take_render.subprocess, "run", lambda *a, **k: Done())
    assert take_render.libx264_available() and take_render.aac_available()
    monkeypatch.setattr(take_render.subprocess, "run", failing)
    assert take_render.libx264_available(), "a good probe is kept"


def test_stale_render_temps_are_swept(tmp_path):
    take = tmp_path / "abcdefabcdef" / "takes" / "t0000aaaa"
    take.mkdir(parents=True)
    stale = take / ".render.mp4.0123456789abcdef.tmp.mp4"
    stale.write_bytes(b"x")
    keep = take / "render.mp4"
    keep.write_bytes(b"y")
    assert take_render.sweep_render_temps(tmp_path) == 1
    assert not stale.exists() and keep.exists()


async def test_a_failed_cover_is_retried_after_a_pause(jobs_dir, monkeypatch):
    from app.core.models import Job
    from app.core.registry import _jobs

    job = Job(
        id="c0ffee000001", status="done", title="x", thumbnail="https://i.ytimg.com/vi/x/hq.jpg"
    )
    _jobs[job.id] = job
    (jobs_dir / job.id).mkdir(parents=True, exist_ok=True)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    calls = []

    def flaky(url, **k):
        calls.append(url)
        if len(calls) == 1:
            raise OSError("host down")
        return png, "image/png"

    monkeypatch.setattr(cover_mod, "fetch_cover", flaky)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app()), base_url="http://testserver"
    ) as c:
        url = f"/api/jobs/{job.id}/cover"
        assert (await c.get(url)).status_code == 404
        # Within the pause: not fetched again.
        assert (await c.get(url)).status_code == 404
        assert len(calls) == 1
        # After it: fetched again, and kept.
        cover_mod._failed_at[job.id] -= cover_mod.COVER_RETRY_AFTER_SEC + 1
        r = await c.get(url)
        assert r.status_code == 200 and r.content == png
        assert len(calls) == 2
    _jobs.pop(job.id, None)


def test_cover_reads_a_slow_drip_within_the_deadline(monkeypatch):
    """read1 returns what has arrived: a server dripping a byte at a time is
    stopped at the deadline, not after a full chunk."""

    class Drip:
        def __init__(self):
            self.calls = 0

        def read1(self, n):
            self.calls += 1
            time.sleep(0.05)
            return b"\x89" if self.calls < 1000 else b""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class Opener:
        def open(self, request, timeout=None):
            return Drip()

    monkeypatch.setattr(cover_mod, "public_url", lambda url: True)
    monkeypatch.setattr(cover_mod.urllib.request, "build_opener", lambda *a: Opener())
    started = time.monotonic()
    with pytest.raises(cover_mod.CoverRefused):
        cover_mod.fetch_cover("https://i.ytimg.com/x.jpg", deadline_sec=0.5)
    assert time.monotonic() - started < 2.0


def test_a_composed_scene_is_placed_at_the_heard_time():
    """Fix pass G: a Streamer scene's frames show the heard playhead, so its
    first frame is placed with the round trip added back and no nudge; a
    filmed camera keeps the audio's placement (round trip and nudge off)."""
    side = {
        "timeline": {"first_sample_song_sec": 29.72},
        "latency": {"round_trip_ms": 150.0, "user_nudge_ms": 40.0},
    }
    video = {"firstFrameAtMs": 22.0}
    assert takes_mod._scene_start_sec(side, video, 0.0) == pytest.approx(29.72 + 0.15 + 0.022)
    assert takes_mod._scene_start_sec(side, video, 10.0) == pytest.approx(29.72 + 0.15 + 0.012)
    assert takes_mod._placement_sec(side) == pytest.approx(29.72 - 0.04)
    no_latency = {"timeline": {"first_sample_song_sec": 5.0}}
    assert takes_mod._scene_start_sec(no_latency, {}, 0.0) == pytest.approx(5.0)
