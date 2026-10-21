"""Which kind of GPU drives torch's "cuda" device.

A ROCm build of torch serves an AMD GPU through torch.cuda, so the device is
"cuda" for NVIDIA and AMD alike; torch_gpu_backend tells them apart for the
Settings line and the startup log. These swap in a stand-in torch module, so
they run whether a real torch is CPU, CUDA, ROCm or absent.
"""

from __future__ import annotations

import sys
import types

import pytest

from app.core import config


def _fake_torch(*, cuda: bool, hip: str | None) -> types.ModuleType:
    torch = types.ModuleType("torch")
    torch.version = types.SimpleNamespace(cuda=None if hip else "12.4", hip=hip)
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: cuda,
        # The backend is read off the build; the card itself is never asked.
        get_device_name=pytest.fail,
    )
    torch.backends = types.SimpleNamespace()
    return torch


@pytest.mark.parametrize(
    ("cuda", "hip", "expected"),
    [
        (True, "6.4.43482-0f2d60242", "rocm"),
        (True, None, "cuda"),
        (False, None, None),
        # A ROCm build on a machine whose GPU it cannot reach.
        (False, "6.4.43482-0f2d60242", None),
    ],
)
def test_backend_is_read_off_the_build(monkeypatch, cuda, hip, expected):
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(cuda=cuda, hip=hip))
    assert config.torch_gpu_backend() == expected
