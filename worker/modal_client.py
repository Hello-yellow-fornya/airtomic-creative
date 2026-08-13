"""HTTP client for the Modal transcription endpoint (modal/transcribe.py).

Submit returns a call id immediately; the GPU function runs detached and we
poll for the result. Plain blocking HTTP would hit Modal's web endpoint
timeout long before a podcast finishes transcribing.
"""

import time
from typing import Any

import requests

POLL_INTERVAL_S = 15
POLL_TIMEOUT_S = 2 * 3600


class TranscriptionError(Exception):
    pass


def transcribe(
    base_url: str,
    token: str,
    audio_url: str,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}

    resp = requests.post(
        f"{base_url}/transcribe",
        json={
            "audio_url": audio_url,
            "min_speakers": min_speakers,
            "max_speakers": max_speakers,
        },
        headers=headers,
        timeout=60,
    )
    resp.raise_for_status()
    call_id = resp.json()["call_id"]

    deadline = time.monotonic() + POLL_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_S)
        resp = requests.get(
            f"{base_url}/result/{call_id}", headers=headers, timeout=60
        )
        resp.raise_for_status()
        body = resp.json()
        if body["status"] == "done":
            return body["result"]
        if body["status"] == "failed":
            raise TranscriptionError(f"modal call {call_id} failed: {body.get('error')}")

    raise TranscriptionError(f"modal call {call_id} did not finish within {POLL_TIMEOUT_S}s")
