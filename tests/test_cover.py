"""The cover endpoint's fetch rules (app/api/cover.py): the host allowlist,
no user info, public addresses only (redirects included), the deadline and
the size cap, network errors as a plain 404, nosniff, one fetch per song."""

from __future__ import annotations

import asyncio
import http.client
import io
import socket
import threading
import time
import urllib.request

import httpx
import pytest

from app.api import cover as cover_mod
from app.core.registry import _jobs
from tests.test_takes_render import JOB, _make_job

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture
def jobs_dir():
    from app.core import config

    cover_mod._fetch_locks.clear()
    cover_mod._fetch_waiters.clear()
    yield config.JOBS_DIR
    _jobs.pop(JOB, None)


def _client():
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def _resolve_to(monkeypatch, address: str) -> None:
    """Every name resolves to `address` (no network in the tests)."""

    def fake(host, port, *a, **k):
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, "", (address, port or 80))]

    monkeypatch.setattr(cover_mod.socket, "getaddrinfo", fake)


# ─── Hosts ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "host",
    [
        "ytimg.com",
        "i.ytimg.com",
        "i9.ytimg.com",
        "yt3.ggpht.com",
        "lh3.googleusercontent.com",
        "i1.sndcdn.com",
        "I.YTIMG.COM",
    ],
)
def test_allowlist_accepts_the_picture_hosts(host):
    assert cover_mod.allowed_host(host)


@pytest.mark.parametrize(
    "host",
    [
        "evilytimg.com",
        "ytimg.com.evil.com",
        "notggpht.com",
        "googleusercontent.com.attacker.net",
        "example.com",
        "localhost",
        "",
    ],
)
def test_allowlist_refuses_lookalikes(host):
    assert not cover_mod.allowed_host(host)


def test_an_allowed_public_host_passes(monkeypatch):
    _resolve_to(monkeypatch, "142.250.1.1")
    assert cover_mod.public_url("https://i.ytimg.com/vi/x/hqdefault.jpg")


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:80@ytimg.com/x.jpg",
        "http://ytimg.com@127.0.0.1/x.jpg",
        "http://user:pass@i.ytimg.com/x.jpg",
        "http://user@i.ytimg.com/x.jpg",
        "http://evilytimg.com/x.jpg",
        "http://ytimg.com.evil.com/x.jpg",
        "file:///etc/passwd",
        "ftp://i.ytimg.com/x.jpg",
        "http://[::1]/x.jpg",
        "javascript:alert(1)",
        "",
    ],
)
def test_user_info_other_hosts_and_schemes_are_refused(monkeypatch, url):
    _resolve_to(monkeypatch, "142.250.1.1")
    assert cover_mod.public_url(url) is False
    with pytest.raises(cover_mod.CoverRefused):
        cover_mod.fetch_cover(url)


@pytest.mark.parametrize(
    "address", ["127.0.0.1", "10.0.0.5", "192.168.1.2", "169.254.169.254", "::1", "fe80::1"]
)
def test_an_allowed_host_resolving_to_a_private_address_is_refused(monkeypatch, address):
    _resolve_to(monkeypatch, address)
    assert cover_mod.public_url("https://i.ytimg.com/x.jpg") is False


def test_a_redirect_to_another_host_is_refused(monkeypatch):
    _resolve_to(monkeypatch, "93.184.216.34")
    handler = cover_mod._PublicRedirects()
    req = urllib.request.Request("https://i.ytimg.com/x.jpg")
    with pytest.raises(cover_mod.CoverRefused):
        handler.redirect_request(req, None, 302, "Found", {}, "https://evil.example/x.jpg")
    with pytest.raises(cover_mod.CoverRefused):
        handler.redirect_request(req, None, 302, "Found", {}, "http://127.0.0.1:80@i.ytimg.com/")
    # Another allowed, public host is followed.
    assert handler.redirect_request(req, None, 302, "Found", {}, "https://i1.ytimg.com/y.jpg")


# ─── Deadline, size, errors ──────────────────────────────────────────────


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def _serve(monkeypatch, body: bytes, read=None):
    _resolve_to(monkeypatch, "142.250.1.1")

    class Opener:
        def open(self, request, timeout=None):
            r = _Response(body)
            if read is not None:
                r.read = read
            return r

    monkeypatch.setattr(cover_mod.urllib.request, "build_opener", lambda *h: Opener())


def test_a_picture_is_fetched(monkeypatch):
    _serve(monkeypatch, PNG)
    assert cover_mod.fetch_cover("https://i.ytimg.com/x.png") == (PNG, "image/png")


def test_more_than_five_megabytes_is_refused(monkeypatch):
    _serve(monkeypatch, PNG + b"\x00" * (cover_mod.COVER_MAX_BYTES + 1))
    with pytest.raises(cover_mod.CoverRefused, match="too large"):
        cover_mod.fetch_cover("https://i.ytimg.com/x.png")


def test_a_slow_drip_stops_at_the_deadline(monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(cover_mod.time, "monotonic", lambda: clock["t"])

    def drip(n=-1):
        clock["t"] += 4.0  # each 64 KB read takes 4 s
        return b"\x89" if clock["t"] < 1100 else b""

    _serve(monkeypatch, b"", read=drip)
    with pytest.raises(cover_mod.CoverRefused, match="too long"):
        cover_mod.fetch_cover("https://i.ytimg.com/x.png", deadline_sec=10.0)


def test_not_a_picture_is_refused(monkeypatch):
    _serve(monkeypatch, b"<html>hello</html>")
    with pytest.raises(cover_mod.CoverRefused):
        cover_mod.fetch_cover("https://i.ytimg.com/x.png")


@pytest.mark.parametrize(
    "error",
    [
        http.client.IncompleteRead(b"x"),
        http.client.InvalidURL("bad"),
        http.client.LineTooLong("header"),
        http.client.RemoteDisconnected("gone"),
        ConnectionResetError(),
        cover_mod.CoverRefused("no"),
    ],
)
async def test_fetch_errors_are_a_plain_404(jobs_dir, monkeypatch, error):
    job = _make_job(jobs_dir)
    job.thumbnail = "https://i.ytimg.com/vi/x/hqdefault.jpg"

    def boom(url):
        raise error

    monkeypatch.setattr(cover_mod, "fetch_cover", boom)
    async with _client() as c:
        r = await c.get(f"/api/jobs/{JOB}/cover")
    assert r.status_code == 404
    assert r.json() == {"detail": "no cover"}


async def test_cover_is_served_with_nosniff(jobs_dir, monkeypatch):
    job = _make_job(jobs_dir)
    job.thumbnail = "https://i.ytimg.com/vi/x/hqdefault.jpg"
    monkeypatch.setattr(cover_mod, "fetch_cover", lambda url: (PNG, "image/png"))
    async with _client() as c:
        first = await c.get(f"/api/jobs/{JOB}/cover")
        cached = await c.get(f"/api/jobs/{JOB}/cover")
    for r in (first, cached):
        assert r.status_code == 200
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["content-type"] == "image/png"


async def test_a_thumbnail_on_another_host_gives_no_cover(jobs_dir, monkeypatch):
    job = _make_job(jobs_dir)
    job.thumbnail = "https://images.example.com/cover.jpg"
    _resolve_to(monkeypatch, "93.184.216.34")
    async with _client() as c:
        r = await c.get(f"/api/jobs/{JOB}/cover")
    assert r.status_code == 404
    assert not (jobs_dir / JOB / cover_mod.COVER_FILE).exists()


async def test_one_fetch_per_song_at_a_time(jobs_dir, monkeypatch):
    job = _make_job(jobs_dir)
    job.thumbnail = "https://i.ytimg.com/vi/x/hqdefault.jpg"
    calls = []
    lock = threading.Lock()

    def slow(url):
        with lock:
            calls.append(url)
        time.sleep(0.3)
        return PNG, "image/png"

    monkeypatch.setattr(cover_mod, "fetch_cover", slow)
    async with _client() as c:
        results = await asyncio.gather(*(c.get(f"/api/jobs/{JOB}/cover") for _ in range(4)))
    assert [r.status_code for r in results] == [200] * 4
    assert len(calls) == 1
    # Nothing is kept once nobody waits.
    assert cover_mod._fetch_locks == {} and cover_mod._fetch_waiters == {}
