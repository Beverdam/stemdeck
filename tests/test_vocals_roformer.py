"""The "roformer" separation model: vocals from a Mel-Band RoFormer, the other
stems from Demucs (app/pipeline/vocals_roformer.py, demucs_worker.py).

The real checkpoint is ~900 MB and is never fetched here. These pin the parts
that decide whether the stems are right whatever the model says: the chunked
inference must give back exactly what the model gives, the six stems must add
up to the song, a download must be the file it claims to be, and the ROCm
workaround must stay where it belongs.
"""

from __future__ import annotations

import hashlib
import io
import json

import pytest
import torch
import torch.nn.functional as F

from app.core import settings as _settings
from app.core.models import Job
from app.pipeline import demucs_worker, vocals_roformer
from app.pipeline import separate as _separate


@pytest.fixture
def small_chunks(monkeypatch):
    """The real 8 s chunks with the same proportions, small enough to be fast."""
    monkeypatch.setattr(vocals_roformer, "CHUNK", 1000)
    monkeypatch.setattr(vocals_roformer, "STEP", 500)
    monkeypatch.setattr(vocals_roformer, "FADE", 100)


class _Scale(torch.nn.Module):
    """A stand-in model whose "vocals" are its input times a factor, with the
    (batch, stems, channels, samples) shape the real one returns."""

    def __init__(self, factor=1.0, short_by=0):
        super().__init__()
        self.factor = factor
        self.short_by = short_by
        self.calls = 0

    def forward(self, x):
        self.calls += 1
        y = x * self.factor
        if self.short_by:
            y = y[..., : -self.short_by]
        return y[:, None]


@pytest.mark.parametrize("length", [1, 999, 1000, 1001, 4321, 10_000])
def test_chunked_inference_gives_back_exactly_what_the_model_gives(small_chunks, length):
    # Overlap, cross-fades and padding must cancel out: a model that returns
    # its input must come back as the input, edges and seams included.
    mix = torch.randn(2, length)
    out = vocals_roformer.separate_vocals(_Scale(), mix, "cpu")
    assert out.shape == mix.shape
    assert torch.allclose(out, mix, atol=1e-5)


def test_chunked_inference_is_linear_in_the_model(small_chunks):
    mix = torch.randn(2, 3333)
    out = vocals_roformer.separate_vocals(_Scale(0.25), mix, "cpu")
    assert torch.allclose(out, 0.25 * mix, atol=1e-5)


def test_chunked_inference_survives_a_model_that_returns_a_few_samples_short(small_chunks):
    # The inverse STFT can drop a hop's worth at the end of a chunk; the fades
    # leave every real sample covered regardless.
    mix = torch.randn(2, 4000)
    out = vocals_roformer.separate_vocals(_Scale(short_by=20), mix, "cpu")
    assert torch.isfinite(out).all()
    assert torch.allclose(out, mix, atol=1e-5)


def test_chunked_inference_reports_progress_up_to_100(small_chunks):
    seen = []
    vocals_roformer.separate_vocals(_Scale(), torch.randn(2, 5000), "cpu", seen.append)
    assert seen == sorted(seen)
    assert seen[-1] == 100


def test_the_stems_add_up_to_the_song(monkeypatch):
    wav = torch.randn(2, 4410)
    sources = ["drums", "bass", "other", "vocals", "guitar", "piano"]

    class _Roformer:
        moved = []

        def to(self, device):
            self.moved.append(device)
            return self

        def cpu(self):
            self.moved.append("cpu")
            return self

    roformer = _Roformer()
    monkeypatch.setattr(demucs_worker, "_load_roformer", lambda: roformer)
    monkeypatch.setattr(
        vocals_roformer, "separate_vocals", lambda model, mix, device, progress: 0.4 * mix
    )

    def fake_demucs(model, mix, device, shifts):
        # Demucs leaves some of its input unexplained and finds stray vocals,
        # as the real one does.
        return torch.stack([mix * w for w in (0.2, 0.1, 0.3, 0.05, 0.1, 0.1)])

    monkeypatch.setattr(demucs_worker, "_demucs", fake_demucs)
    model = type("M", (), {"sources": sources})()

    stems = demucs_worker._roformer_stems(model, wav, "cuda", 1)

    assert set(stems) == set(sources)
    assert torch.allclose(stems["vocals"], 0.4 * wav)
    rest = 0.6 * wav
    assert torch.allclose(stems["drums"], 0.2 * rest)
    assert torch.allclose(sum(stems.values()), wav, atol=1e-6)
    # Back on the CPU afterwards, so Demucs has the VRAM.
    assert roformer.moved == ["cuda", "cpu"]


class _Response(io.BytesIO):
    def __init__(self, body: bytes):
        super().__init__(body)
        self.headers = {"Content-Length": str(len(body))}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def test_a_download_is_kept_only_when_it_matches_its_checksum(tmp_path, monkeypatch):
    body = b"weights" * 1000
    monkeypatch.setattr(vocals_roformer, "CHECKPOINT_SHA256", hashlib.sha256(body).hexdigest())
    monkeypatch.setattr(vocals_roformer.urllib.request, "urlopen", lambda *a, **kw: _Response(body))
    seen = []

    path = vocals_roformer.ensure_checkpoint(tmp_path, seen.append)

    assert path == vocals_roformer.checkpoint_path(tmp_path)
    assert path.read_bytes() == body
    assert seen[-1] == 100
    assert not list(path.parent.glob("*.part"))


def test_a_download_that_does_not_match_leaves_nothing_behind(tmp_path, monkeypatch):
    monkeypatch.setattr(vocals_roformer, "CHECKPOINT_SHA256", "0" * 64)
    monkeypatch.setattr(
        vocals_roformer.urllib.request, "urlopen", lambda *a, **kw: _Response(b"truncated")
    )

    with pytest.raises(RuntimeError, match="checksum"):
        vocals_roformer.ensure_checkpoint(tmp_path)

    root = vocals_roformer.checkpoint_path(tmp_path).parent
    assert list(root.iterdir()) == []


def test_a_present_checkpoint_is_not_downloaded_again(tmp_path, monkeypatch):
    path = vocals_roformer.checkpoint_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"x")

    def no_network(*a, **kw):
        raise AssertionError("downloaded a checkpoint that was already there")

    monkeypatch.setattr(vocals_roformer.urllib.request, "urlopen", no_network)
    assert vocals_roformer.ensure_checkpoint(tmp_path) == path


def _sdpa_spy(monkeypatch):
    seen = []

    def spy(q, k, v, *args, **kwargs):
        seen.append(v.is_contiguous())
        return v

    monkeypatch.setattr(F, "scaled_dot_product_attention", spy)
    return seen, spy


def _transposed_v():
    q = k = torch.randn(1, 2, 4, 8)
    v = torch.randn(1, 4, 2, 8).transpose(1, 2)
    assert not v.is_contiguous()
    return q, k, v


def test_on_rocm_attention_gets_contiguous_tensors_and_is_put_back(monkeypatch):
    seen, spy = _sdpa_spy(monkeypatch)
    monkeypatch.setattr(torch.version, "hip", "6.4.43482", raising=False)

    with vocals_roformer._contiguous_sdpa("cuda"):
        F.scaled_dot_product_attention(*_transposed_v())

    assert seen == [True]
    assert F.scaled_dot_product_attention is spy


@pytest.mark.parametrize(("hip", "device"), [(None, "cuda"), ("6.4.43482", "cpu")])
def test_the_workaround_stays_off_where_it_is_not_needed(monkeypatch, hip, device):
    seen, _ = _sdpa_spy(monkeypatch)
    monkeypatch.setattr(torch.version, "hip", hip, raising=False)

    with vocals_roformer._contiguous_sdpa(device):
        F.scaled_dot_product_attention(*_transposed_v())

    assert seen == [False]


def test_separation_model_setting(monkeypatch):
    assert _settings.get_separation_model() == "demucs"
    assert _settings.set_separation_model("RoFormer") == "roformer"
    assert _settings.get_separation_model() == "roformer"
    with pytest.raises(ValueError):
        _settings.set_separation_model("spleeter")


def test_the_environment_seeds_the_default(monkeypatch):
    monkeypatch.setenv("STEMDECK_SEPARATION_MODEL", "roformer")
    assert _settings.get_separation_model() == "roformer"


def test_the_roformer_is_never_used_where_it_cannot_run(monkeypatch):
    _settings.set_separation_model("roformer")
    monkeypatch.setattr(vocals_roformer, "available", lambda: False)

    assert _settings.separation_models_available() == ["demucs"]
    assert _settings.get_separation_model() == "demucs"
    with pytest.raises(ValueError, match="not available"):
        _settings.set_separation_model("roformer")


@pytest.fixture
def client():
    from unittest.mock import patch

    from fastapi.testclient import TestClient

    with patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None):
        from app.main import app

        with TestClient(app) as c:
            yield c


def test_the_settings_api_round_trips_the_model(client):
    body = client.get("/api/settings").json()
    assert body["separation_model"] == "demucs"
    assert "roformer" in body["separation_models_available"]

    assert client.post("/api/settings", json={"separation_model": "roformer"}).status_code == 200
    assert client.get("/api/settings").json()["separation_model"] == "roformer"
    assert client.post("/api/settings", json={"separation_model": "nope"}).status_code == 422


class _Pipe:
    def __init__(self, text=""):
        self.text = text
        self.pos = 0
        self.written = ""

    def write(self, data):
        self.written += data

    def flush(self):
        return None

    def read(self, _n):
        ch = self.text[self.pos : self.pos + 1]
        self.pos += 1
        return ch


def test_a_roformer_job_shows_each_phase_on_one_progress_bar(tmp_path, monkeypatch):
    stream = (
        "@@PHASE@@download\n50%\n@@PHASE@@vocals\n0%\r50%\r100%\n"
        "@@PHASE@@instruments\n50%\r100%\n@@DONE@@\n"
    )
    proc = type("P", (), {"poll": lambda self: None, "terminate": lambda self: None})()
    proc.stdin, proc.stderr = _Pipe(), _Pipe(stream)
    monkeypatch.setattr(_separate, "_get_worker", lambda device: proc)
    monkeypatch.setattr(_separate, "set_proc", lambda *a, **kw: None)
    updates = []
    monkeypatch.setattr(
        _separate, "_set", lambda job, **kw: updates.append((kw.get("progress"), kw.get("stage")))
    )

    job = Job(id="a1b2c3d4e5f6", status="separating", separation_model="roformer")
    assert _separate._run_demucs(job, tmp_path / "s.wav", tmp_path, "cuda") == (0, [])

    assert json.loads(proc.stdin.written)["vocals_model"] == "roformer"
    progress = [p for p, _ in updates]
    assert progress == sorted(progress), "the bar went backwards between phases"
    assert updates[-1] == (1.0, "Separating instruments 100%")
    assert (0.0, "Downloading the vocals model 50%") in updates
    assert (0.25, "Separating vocals 50%") in updates
    assert (0.75, "Separating instruments 50%") in updates
    # The download is not worker startup.
    assert job.stage_timings and "separate_startup" in job.stage_timings
