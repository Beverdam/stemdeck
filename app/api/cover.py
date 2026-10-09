"""A song's cover picture, served from this origin.

    GET /api/jobs/{id}/cover    the picture (JPEG, PNG, WebP or GIF), or 404

A song imported from a link has the source's picture as a remote URL
(job.thumbnail). A remote picture drawn into a canvas taints it: Streamer
Mode's recorder could then not capture its frames, and the preview could not
be read back. So the picture is fetched here once, kept beside the job, and
served from the app's own origin.

The URL comes from the job (what yt-dlp reported), never from the request.
It is still only fetched when it is plain http(s) to one of the picture
hosts of the sources StemDeck imports from (COVER_HOSTS, a suffix on a dot
boundary), with no user name or password in it, from public addresses only,
redirects included, with a size cap and an overall deadline. A song whose
picture lives anywhere else has no cover here: its scene is drawn without
the album art.

The host allowlist is the control against a page's metadata making the
server fetch from the local network. The resolved addresses are checked as
well; pinning the connection to the checked address (against a DNS answer
that changes between the check and the fetch) is the possible next step.
"""

from __future__ import annotations

import asyncio
import http.client
import ipaddress
import logging
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.core.config import (
    COVER_DEADLINE_SEC,
    COVER_HOSTS,
    COVER_MAX_BYTES,
    COVER_RETRY_AFTER_SEC,
    JOB_ID_RE,
    JOBS_DIR,
)
from app.core.registry import get as registry_get

logger = logging.getLogger("stemdeck.api")

router = APIRouter(tags=["jobs"])

COVER_FILE = "cover.img"
# Read as soon as any bytes arrive (read1), at most this much at a time, so
# the deadline (COVER_DEADLINE_SEC, the whole fetch, redirects and the
# slowest trickle of bytes included) is checked between small reads.
_CHUNK = 16 * 1024
_USER_AGENT = "StemDeck cover fetch"

# A fetch that failed is not tried again for COVER_RETRY_AFTER_SEC: every
# frame of a scene asks for the cover, and a dead host would otherwise be
# asked again each time. job id -> monotonic time of the failure.
_failed_at: dict[str, float] = {}

# One fetch per song at a time: a second request waits for the first and then
# finds the cached file. Entries are removed once nobody waits on them.
_fetch_locks: dict[str, asyncio.Lock] = {}
_fetch_waiters: dict[str, int] = {}


class CoverRefused(ValueError):
    pass


def sniff_image(data: bytes) -> str | None:
    """The picture's media type from its first bytes, or None for anything else."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def allowed_host(host: str) -> bool:
    """`host` is one of COVER_HOSTS or a subdomain of one (a dot boundary:
    evilytimg.com is not ytimg.com)."""
    h = (host or "").lower().rstrip(".")
    return any(h == base or h.endswith("." + base) for base in COVER_HOSTS)


def public_url(url: str) -> bool:
    """http(s), no user name or password, a host on COVER_HOSTS, and every
    address it resolves to public (not loopback, private, link-local,
    reserved or multicast)."""
    try:
        parsed = urllib.parse.urlparse(url)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not host:
        return False
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        return False
    if not allowed_host(host):
        return False
    try:
        infos = socket.getaddrinfo(host, port or None, proto=socket.IPPROTO_TCP)
    except (OSError, UnicodeError):
        return False
    if not infos:
        return False
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if not addr.is_global:
            return False
    return True


class _PublicRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to another allowed, public http(s) address."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not public_url(newurl):
            raise CoverRefused("redirect to a host that is not allowed")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_cover(url: str, *, deadline_sec: float = COVER_DEADLINE_SEC) -> tuple[bytes, str]:
    """The picture at `url` and its media type. Raises CoverRefused (refused,
    too large, too slow or not a picture), OSError or http.client.HTTPException
    (network)."""
    if not public_url(url):
        raise CoverRefused("cover URL is not an allowed public http(s) address")
    deadline = time.monotonic() + deadline_sec
    opener = urllib.request.build_opener(_PublicRedirects())
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    # The scheme, the host and every address are checked above and on each
    # redirect; B310 is about file:// and custom schemes, which are refused.
    timeout = max(1.0, deadline - time.monotonic())
    with opener.open(request, timeout=timeout) as response:  # nosec B310
        chunks: list[bytes] = []
        size = 0
        while True:
            if time.monotonic() > deadline:
                raise CoverRefused("cover took too long")
            # read1: what has arrived, not a full chunk, so a slow drip
            # cannot hold one read past the deadline.
            chunk = response.read1(_CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > COVER_MAX_BYTES:
                raise CoverRefused("cover too large")
            chunks.append(chunk)
    data = b"".join(chunks)
    kind = sniff_image(data)
    if kind is None:
        raise CoverRefused("cover is not a picture")
    return data, kind


def _write_atomic(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


async def _cached(path: Path) -> tuple[bytes, str] | None:
    if not path.is_file():
        return None
    data = await asyncio.to_thread(path.read_bytes)
    kind = sniff_image(data)
    return (data, kind) if kind is not None else None


@router.get("/{job_id}/cover", response_model=None)
async def get_cover(job_id: str) -> Response:
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="not found")
    jobs_root = JOBS_DIR.resolve()
    folder = (JOBS_DIR / job_id).resolve()
    path = (folder / COVER_FILE).resolve()
    if not folder.is_dir() or not path.is_relative_to(jobs_root):
        raise HTTPException(status_code=404, detail="not found")
    headers = {"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"}

    hit = await _cached(path)
    if hit is not None:
        return Response(content=hit[0], media_type=hit[1], headers=headers)

    url = job.thumbnail
    if not url or not isinstance(url, str):
        raise HTTPException(status_code=404, detail="no cover")
    failed = _failed_at.get(job_id)
    if failed is not None and time.monotonic() - failed < COVER_RETRY_AFTER_SEC:
        raise HTTPException(status_code=404, detail="no cover")

    lock = _fetch_locks.setdefault(job_id, asyncio.Lock())
    _fetch_waiters[job_id] = _fetch_waiters.get(job_id, 0) + 1
    try:
        async with lock:
            # The fetch before this one (another request) may have kept it.
            hit = await _cached(path)
            if hit is not None:
                return Response(content=hit[0], media_type=hit[1], headers=headers)
            try:
                data, kind = await asyncio.to_thread(fetch_cover, url)
            except (ValueError, OSError, http.client.HTTPException):
                logger.warning("[%s] cover not fetched", job_id, exc_info=True)
                _failed_at[job_id] = time.monotonic()
                raise HTTPException(status_code=404, detail="no cover") from None
            _failed_at.pop(job_id, None)
            try:
                await asyncio.to_thread(_write_atomic, path, data)
            except OSError:
                logger.warning("[%s] cover not cached", job_id, exc_info=True)
            return Response(content=data, media_type=kind, headers=headers)
    finally:
        _fetch_waiters[job_id] -= 1
        if _fetch_waiters[job_id] <= 0:
            _fetch_waiters.pop(job_id, None)
            _fetch_locks.pop(job_id, None)
