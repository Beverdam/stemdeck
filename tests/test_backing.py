"""Streamer Mode's backing track: a song without one stem, mixed on demand.

GET /api/jobs/{id}/backing/{stem}.wav: validation (job id, stem whitelist,
job state, traversal), caching (built once, never rebuilt while its stems are
unchanged, rebuilt when they change, one build under concurrent requests),
the mix (equal to the sum of the other stems, never clipped), Voice with and
without the lead/backing split; and the take render leaving the same stem out.
"""

from __future__ import annotations

import asyncio
import os

import httpx
import numpy as np
import pytest
import soundfile as sf

from app.api import stems as stems_mod
from app.api import takes as takes_mod
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import backing as backing_mod

JOB = "bacc0ba0c001"
SR = 44100
SEC = 2.0
FREQ = {"vocals": 440, "drums": 90, "bass": 55, "guitar": 330, "piano": 262, "other": 600}


def _app():
    from app.main import app

    return app


@pytest.fixture
def jobs_dir():
    from app.core import config

    yield config.JOBS_DIR
    _jobs.pop(JOB, None)


@pytest.fixture
def client(jobs_dir):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app()), base_url="http://testserver"
    )


def _make_job(jobs_dir, amp=0.1, names=tuple(FREQ), status="done") -> Job:
    job = Job(id=JOB, status=status, title="Song", duration_sec=SEC)
    _jobs[job.id] = job
    stems = jobs_dir / JOB / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    t = np.arange(int(SR * SEC)) / SR
    for name in names:
        x = amp * np.sin(2 * np.pi * FREQ.get(name, 700) * t)
        sf.write(stems / f"{name}.wav", np.stack([x, x], 1), SR, subtype="PCM_16")
    return job


def _read(path):
    data, sr = sf.read(str(path), dtype="float64", always_2d=True)
    assert sr == SR
    return data


def _sum(jobs_dir, names):
    return sum(_read(jobs_dir / JOB / "stems" / f"{n}.wav") for n in names)


# ─── Validation ──────────────────────────────────────────────────────────


async def test_bad_requests_are_refused(jobs_dir, client):
    _make_job(jobs_dir)
    async with client as c:
        assert (await c.get(f"/api/jobs/{JOB}/backing/kazoo.wav")).status_code == 422
        assert (await c.get(f"/api/jobs/{JOB}/backing/original.wav")).status_code == 422
        assert (await c.get("/api/jobs/not-a-job/backing/bass.wav")).status_code == 404
        assert (await c.get("/api/jobs/..%2F..%2Fetc/backing/bass.wav")).status_code == 404
        assert (await c.get("/api/jobs/ffffffffffff/backing/bass.wav")).status_code == 404
        r = await c.get(f"/api/jobs/{JOB}/backing/..%2Fbass.wav")
        assert r.status_code in (404, 422)
    assert not list((jobs_dir / JOB).glob("backing_without_*"))


async def test_a_job_still_processing_has_no_backing(jobs_dir, client):
    _make_job(jobs_dir, status="processing")
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/backing/bass.wav")
    assert r.status_code == 404 and "not ready" in r.json()["detail"]


async def test_a_job_without_stems_says_so(jobs_dir, client):
    _make_job(jobs_dir, names=())
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/backing/bass.wav")
    assert r.status_code == 404
    assert str(jobs_dir) not in r.text, "no paths in errors"


# ─── The mix ─────────────────────────────────────────────────────────────


async def test_the_backing_is_the_sum_of_the_other_stems(jobs_dir, client):
    _make_job(jobs_dir)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/backing/bass.wav")
        assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
        ranged = await c.get(f"/api/jobs/{JOB}/backing/bass.wav", headers={"Range": "bytes=0-99"})
        assert ranged.status_code == 206 and len(ranged.content) == 100
    out = _read(jobs_dir / JOB / "backing_without_bass.wav")
    want = _sum(jobs_dir, [n for n in FREQ if n != "bass"])
    assert out.shape == want.shape
    assert np.max(np.abs(out - want)) < 2 / 32768, "the same as summing the other five"
    # No bass left: its 55 Hz line is gone, the others' are there.
    spec = np.abs(np.fft.rfft(out[:, 0]))
    freqs = np.fft.rfftfreq(len(out), 1 / SR)
    at = lambda f: spec[np.argmin(np.abs(freqs - f))]  # noqa: E731
    assert at(55) < at(90) / 1000


async def test_a_loud_backing_is_scaled_never_clipped(jobs_dir):
    _make_job(jobs_dir, amp=0.35)  # five at 0.35 in phase at t=0 would pass full scale
    path, built = backing_mod.ensure_backing(JOB, jobs_dir / JOB, "bass")
    assert built
    out = _read(path)
    assert np.max(np.abs(out)) <= 0.9991
    meta = (path.with_suffix(".json")).read_text(encoding="utf-8")
    assert '"gain": 1.0' not in meta


# ─── Caching ─────────────────────────────────────────────────────────────


async def test_a_second_request_does_not_rebuild(jobs_dir, client, monkeypatch):
    _make_job(jobs_dir)
    builds = []
    real = backing_mod._mix

    def counted(paths, out):
        builds.append(out)
        return real(paths, out)

    monkeypatch.setattr(backing_mod, "_mix", counted)
    async with client as c:
        assert (await c.get(f"/api/jobs/{JOB}/backing/drums.wav")).status_code == 200
        mtime = (jobs_dir / JOB / "backing_without_drums.wav").stat().st_mtime_ns
        assert (await c.get(f"/api/jobs/{JOB}/backing/drums.wav")).status_code == 200
    assert len(builds) == 1
    assert (jobs_dir / JOB / "backing_without_drums.wav").stat().st_mtime_ns == mtime


async def test_concurrent_requests_build_once(jobs_dir, client, monkeypatch):
    _make_job(jobs_dir)
    builds = []
    real = backing_mod._mix

    def slow(paths, out):
        builds.append(out)
        import time

        time.sleep(0.3)
        return real(paths, out)

    monkeypatch.setattr(backing_mod, "_mix", slow)
    async with client as c:
        rs = await asyncio.gather(*(c.get(f"/api/jobs/{JOB}/backing/guitar.wav") for _ in range(4)))
    assert [r.status_code for r in rs] == [200] * 4
    assert len(builds) == 1
    assert len({r.content for r in rs}) == 1
    assert not list((jobs_dir / JOB).glob(".backing_without_*.tmp.wav"))


def test_changed_stems_make_a_new_backing(jobs_dir):
    _make_job(jobs_dir)
    path, built = backing_mod.ensure_backing(JOB, jobs_dir / JOB, "piano")
    assert built
    assert backing_mod.ensure_backing(JOB, jobs_dir / JOB, "piano") == (path, False)
    # A re-split writes new stems: the backing follows.
    drums = jobs_dir / JOB / "stems" / "drums.wav"
    t = np.arange(int(SR * SEC)) / SR
    x = 0.05 * np.sin(2 * np.pi * 120 * t)
    sf.write(drums, np.stack([x, x], 1), SR, subtype="PCM_16")
    os.utime(drums, ns=(drums.stat().st_atime_ns, drums.stat().st_mtime_ns + 10_000_000))
    _, rebuilt = backing_mod.ensure_backing(JOB, jobs_dir / JOB, "piano")
    assert rebuilt


# ─── Voice ───────────────────────────────────────────────────────────────


def test_voice_is_the_vocals_stem(jobs_dir):
    _make_job(jobs_dir, names=(*FREQ, "lead_vocals", "backing_vocals"))
    stems = jobs_dir / JOB / "stems"
    names = [p.name for p in backing_mod.backing_inputs(stems, "vocals")]
    assert "vocals.wav" not in names and "lead_vocals.wav" not in names
    assert "backing_vocals.wav" not in names
    # vocals.wav (lead and backing together) is used for the others; the
    # split halves are never added on top of it.
    names = [p.name for p in backing_mod.backing_inputs(stems, "bass")]
    assert "vocals.wav" in names and "lead_vocals.wav" not in names


def test_without_vocals_wav_the_split_stands_in(jobs_dir):
    _make_job(
        jobs_dir,
        names=("drums", "bass", "guitar", "piano", "other", "lead_vocals", "backing_vocals"),
    )
    stems = jobs_dir / JOB / "stems"
    names = {p.name for p in backing_mod.backing_inputs(stems, "bass")}
    assert {"lead_vocals.wav", "backing_vocals.wav"} <= names
    names = {p.name for p in backing_mod.backing_inputs(stems, "vocals")}
    assert not names & {"lead_vocals.wav", "backing_vocals.wav", "vocals.wav"}


def test_unknown_stems_are_refused_by_the_builder(jobs_dir):
    with pytest.raises(ValueError):
        backing_mod.backing_inputs(jobs_dir, "../bass")


# ─── The take render leaves the same stem out ─────────────────────────────


def test_render_body_takes_the_removed_stem():
    assert takes_mod.RenderBody(remove_stem="bass").remove_stem == "bass"
    assert takes_mod.RenderBody().remove_stem is None
    with pytest.raises(ValueError):
        takes_mod.RenderBody(remove_stem="kazoo")
    assert takes_mod.removed_stems("vocals") == {"vocals", "lead_vocals", "backing_vocals"}
    assert takes_mod.removed_stems("bass") == {"bass"}
    assert takes_mod.removed_stems(None) == frozenset()


def test_the_render_rebuilds_original_without_the_removed_stem(jobs_dir):
    _make_job(jobs_dir, names=(*FREQ, "original"))
    names = ["original", "vocals"]
    lanes, _ = stems_mod._expand_render_lanes(JOB, names, [1.0, 0.8], [0, 0], frozenset({"bass"}))
    got = {(lane.name, lane.path.name) for lane in lanes}
    # "original" is the complement of the vocals lane, without the bass.
    assert ("original", "bass.wav") not in got
    assert {("original", f"{n}.wav") for n in ("drums", "guitar", "piano", "other")} <= got
    assert ("vocals", "vocals.wav") in got
    assert all(lane.gain == 1.0 for lane in lanes if lane.name == "original")
    # Without a removed stem, nothing changes: the rendered original.wav.
    plain, _ = stems_mod._expand_render_lanes(JOB, names, [1.0, 0.8], [0, 0])
    assert [(lane.name, lane.path.name) for lane in plain] == [
        ("original", "original.wav"),
        ("vocals", "vocals.wav"),
    ]
    # A removed stem that is a lane of its own is dropped.
    lanes, _ = stems_mod._expand_render_lanes(JOB, names, [1.0, 0.8], [0, 0], frozenset({"vocals"}))
    assert all(lane.name != "vocals" for lane in lanes)
    assert all(lane.path.name != "vocals.wav" for lane in lanes)
