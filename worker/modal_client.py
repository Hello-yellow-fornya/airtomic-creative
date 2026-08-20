"""HTTP client for the Modal transcription endpoint (modal/transcribe.py).

Submit returns a call id immediately; the GPU function runs detached and we
poll for the result. Plain blocking HTTP would hit Modal's web endpoint
timeout long before a podcast finishes transcribing.
"""

import logging
import time
from typing import Any

import requests

log = logging.getLogger("worker.modal")

POLL_INTERVAL_S = 15
POLL_TIMEOUT_S = 2 * 3600


class TranscriptionError(Exception):
    pass


def preflight(base_url: str) -> None:
    """Cheap unauthenticated GET against the Modal app before queueing a
    batch. A healthy deployment answers the root with a normal FastAPI 404
    JSON; a disabled workspace answers every path with a modal-http error
    banner ('workspace ... is disabled') — which previously surfaced only
    as a bare 404 on /transcribe, one video at a time. Raises with the
    actual body so the operator sees Modal's own words."""
    try:
        resp = requests.get(base_url, timeout=30)
    except requests.RequestException as exc:
        raise TranscriptionError(f"modal preflight: cannot reach {base_url}: {exc}")
    body = resp.text[:300]
    if "modal-http" in body:
        raise TranscriptionError(
            f"modal preflight: endpoint is not serving — {body.strip()}")


def _raise_with_body(resp: requests.Response, context: str) -> None:
    """raise_for_status, but keep Modal's error body — 'modal-http:
    workspace ... is disabled' is the diagnosis and vanishes otherwise."""
    if resp.ok:
        return
    body = resp.text[:300].strip()
    raise TranscriptionError(
        f"modal {context} failed: HTTP {resp.status_code}"
        + (f" — {body}" if body else ""))


def transcribe(
    base_url: str,
    token: str,
    audio_url: str,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
    diarise: bool = True,
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}

    resp = requests.post(
        f"{base_url}/transcribe",
        json={
            "audio_url": audio_url,
            "min_speakers": min_speakers,
            "max_speakers": max_speakers,
            "diarise": diarise,
        },
        headers=headers,
        timeout=60,
    )
    _raise_with_body(resp, "submit")
    call_id = resp.json()["call_id"]

    deadline = time.monotonic() + POLL_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_S)
        resp = requests.get(
            f"{base_url}/result/{call_id}", headers=headers, timeout=60
        )
        _raise_with_body(resp, f"poll {call_id}")
        body = resp.json()
        if body["status"] == "done":
            return body["result"]
        if body["status"] == "failed":
            raise TranscriptionError(f"modal call {call_id} failed: {body.get('error')}")

    raise TranscriptionError(f"modal call {call_id} did not finish within {POLL_TIMEOUT_S}s")
