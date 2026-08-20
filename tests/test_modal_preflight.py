"""Modal pre-flight and error-body surfacing."""

import pytest
import requests

from worker.modal_client import TranscriptionError, _raise_with_body, preflight


class FakeResp:
    def __init__(self, status: int, text: str):
        self.status_code = status
        self.text = text
        self.ok = status < 400


def test_raise_with_body_keeps_modal_banner():
    resp = FakeResp(404, "modal-http: workspace ac-xyz is disabled")
    with pytest.raises(TranscriptionError) as e:
        _raise_with_body(resp, "submit")
    assert "workspace ac-xyz is disabled" in str(e.value)
    assert "HTTP 404" in str(e.value)


def test_raise_with_body_ok_passes():
    _raise_with_body(FakeResp(200, "fine"), "submit")   # no raise


def test_preflight_detects_disabled_workspace(monkeypatch):
    monkeypatch.setattr(requests, "get",
                        lambda url, timeout: FakeResp(404, "modal-http: workspace x is disabled"))
    with pytest.raises(TranscriptionError) as e:
        preflight("https://example.modal.run")
    assert "is disabled" in str(e.value)


def test_preflight_accepts_normal_fastapi_404(monkeypatch):
    monkeypatch.setattr(requests, "get",
                        lambda url, timeout: FakeResp(404, '{"detail":"Not Found"}'))
    preflight("https://example.modal.run")   # healthy app: no raise


def test_preflight_network_error(monkeypatch):
    def boom(url, timeout):
        raise requests.ConnectionError("refused")
    monkeypatch.setattr(requests, "get", boom)
    with pytest.raises(TranscriptionError) as e:
        preflight("https://example.modal.run")
    assert "cannot reach" in str(e.value)
