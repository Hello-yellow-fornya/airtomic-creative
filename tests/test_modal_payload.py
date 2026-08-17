"""Guard the transcribe → api serialisation boundary.

transcribe runs in gpu_image (numpy present); the api web function runs in
a light image (numpy deliberately absent). The return value crosses that
boundary via Modal's pickle transport, so an np.float32 anywhere in the
payload makes `call.get()` fail in the api container with
"Deserialization failed because the 'numpy' module is not available".
This happened in production. WhisperX puts numpy scalars in segment and
word timings and confidence scores, so the payload must be recursively
converted to plain types at source.

These tests run the real _build_payload against WhisperX-shaped output
laced with numpy types and assert the result survives json.dumps with
allow_nan=False — the settings starlette uses on the /result route.
"""

import importlib.util
import json
import math
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_transcribe_module():
    spec = importlib.util.spec_from_file_location(
        "transcribe_mod", REPO_ROOT / "modal" / "transcribe.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _whisperx_shaped_result():
    # Mirrors what whisperx.align / assign_word_speakers actually return:
    # numpy scalars in timings and scores, occasional missing keys, and —
    # rarely — a NaN score.
    return {
        "segments": [
            {
                "start": np.float64(0.031),
                "end": np.float32(2.5),
                "text": " Four score and seven ",
                "speaker": "SPEAKER_00",
                "words": [
                    {
                        "word": "Four",
                        "start": np.float64(0.031),
                        "end": np.float64(0.55),
                        "score": np.float32(0.98),
                        "speaker": "SPEAKER_00",
                    },
                    # unaligned word: no timings, NaN score
                    {"word": "7", "score": np.float32("nan")},
                ],
            },
            # segment with no words key at all
            {"start": np.float64(2.5), "end": np.float64(3.0), "text": "years"},
        ]
    }


def test_payload_survives_json_dumps_without_nan():
    mod = _load_transcribe_module()
    payload = mod._build_payload(
        _whisperx_shaped_result(),
        language="en",
        diarised=True,
        diarisation_error=None,
        n_samples=48_000,
    )
    # allow_nan=False matches starlette's JSONResponse encoder — a NaN that
    # slips through would 500 the /result poll even with numpy handled.
    encoded = json.dumps(payload, allow_nan=False)
    decoded = json.loads(encoded)
    assert decoded["segments"][0]["words"][0]["word"] == "Four"


def test_no_numpy_types_anywhere_in_payload():
    mod = _load_transcribe_module()
    payload = mod._build_payload(
        _whisperx_shaped_result(), "en", False, "token rejected", 48_000
    )

    def walk(v):
        assert not isinstance(v, (np.generic, np.ndarray)), f"numpy leaked: {v!r}"
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, float):
            assert math.isfinite(v), f"non-finite float leaked: {v!r}"

    walk(payload)
    # The NaN score must degrade to null, not vanish or crash.
    assert payload["segments"][0]["words"][1]["score"] is None
    assert payload["duration_s"] == 3.0
