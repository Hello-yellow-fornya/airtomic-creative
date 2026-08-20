"""WhisperX transcription on Modal: large-v3 + alignment + diarisation.

The worker talks to this over HTTP only (no Modal SDK on the worker side):

    POST {MODAL_TRANSCRIBE_URL}/transcribe   {"audio_url": "...", "min_speakers": 2, "max_speakers": 2}
        -> {"call_id": "fc-..."}
    GET  {MODAL_TRANSCRIBE_URL}/result/{call_id}
        -> {"status": "running"}
         | {"status": "done", "result": {...}}
         | {"status": "failed", "error": "..."}

Both routes require `Authorization: Bearer $MODAL_TOKEN`. The submit/poll split
exists because a 90-minute podcast takes minutes to transcribe and Modal web
endpoints time out long before that; the GPU function runs detached.

`audio_url` should be a presigned R2 URL for a 16kHz mono WAV — extraction
happens on the worker, not here (see CLAUDE.md known traps).

Deploy:
    modal secret create huggingface HF_TOKEN=<token>
        # The token's account must have accepted the terms for BOTH
        # pyannote/speaker-diarization-3.1 AND pyannote/segmentation-3.0,
        # or diarisation fails at runtime with an unhelpful error.
    modal secret create airtomic-transcribe-auth MODAL_TOKEN=<random string>
        # Same value goes in the worker's MODAL_TOKEN env var.
    modal deploy modal/transcribe.py
        # Prints the URL for the worker's MODAL_TRANSCRIBE_URL.
"""

import json
import os
import secrets as py_secrets

import modal

WHISPER_MODEL = "large-v3"
GPU = "A10G"
MODELS_DIR = "/models"

app = modal.App("airtomic-transcribe")


DIARISATION_MODEL = "pyannote/speaker-diarization-3.1"
GATED_REPOS = (DIARISATION_MODEL, "pyannote/segmentation-3.0")


def _validate_hf_access(token: str) -> None:
    """Fail fast, with a precise reason, if the HF token can't reach the
    gated pyannote repos. Runs first in the image bake, so a bad secret
    fails the DEPLOY — not the first transcription."""
    import requests

    if not token or not token.startswith("hf_"):
        raise RuntimeError(
            "HF_TOKEN missing or malformed in the 'huggingface' Modal secret "
            "(expected a token starting with hf_)."
        )
    r = requests.get(
        "https://huggingface.co/api/whoami-v2",
        headers={"Authorization": f"Bearer {token}"}, timeout=30,
    )
    if r.status_code != 200:
        raise RuntimeError(
            f"HF_TOKEN rejected by Hugging Face (whoami returned {r.status_code}). "
            "Update the 'huggingface' Modal secret: "
            "modal secret create huggingface HF_TOKEN=<token> --force"
        )
    account = r.json().get("name", "<unknown>")
    for repo in GATED_REPOS:
        r = requests.get(
            f"https://huggingface.co/{repo}/resolve/main/config.yaml",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30, allow_redirects=True,
        )
        if r.status_code != 200:
            raise RuntimeError(
                f"HF token (account '{account}') cannot access gated repo "
                f"{repo} (HTTP {r.status_code}). Accept the terms at "
                f"https://huggingface.co/{repo} while logged into that "
                "account — BOTH gated repos must be accepted (see CLAUDE.md)."
            )


def _download_models() -> None:
    """Bake model weights into the image at build time (see CLAUDE.md known
    traps) — otherwise every cold start re-downloads several GB."""
    import hashlib
    import subprocess
    import sys
    import tempfile
    import zipfile

    import torch
    import whisperx
    from pyannote.audio import Pipeline

    # Cache-bust knob: Modal caches this layer on the function's source, so
    # bump this number to force a clean re-bake of all model weights
    # (e.g. after fixing a bad HF secret). MODAL_FORCE_BUILD=1 also works.
    bake_version = 2

    _validate_hf_access(os.environ.get("HF_TOKEN", ""))

    # whisperx 3.1.5 fetches its VAD model from a hardcoded S3 bucket that no
    # longer exists (returns 301, no followable Location). The byte-identical
    # file — same sha256 that whisperx's loader verifies — ships inside the
    # official whisperx 3.8.1 wheel, so lift it from there into the cache
    # path load_vad_model checks first, and no download is ever attempted.
    vad_sha256 = "0b5b3216d60a2d32fc086b47ea8c67589aaeb26b7e07fcbe620d6d0b83e209ea"
    vad_fp = os.path.join(torch.hub._get_torch_home(), "whisperx-vad-segmentation.bin")
    os.makedirs(os.path.dirname(vad_fp), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            [sys.executable, "-m", "pip", "download", "-q", "--no-deps",
             "whisperx==3.8.1", "-d", tmp],
            check=True,
        )
        wheel = next(p for p in os.listdir(tmp) if p.endswith(".whl"))
        with zipfile.ZipFile(os.path.join(tmp, wheel)) as zf:
            vad_bytes = zf.read("whisperx/assets/pytorch_model.bin")
    if hashlib.sha256(vad_bytes).hexdigest() != vad_sha256:
        raise RuntimeError("VAD weights from whisperx 3.8.1 wheel failed hash check")
    with open(vad_fp, "wb") as f:
        f.write(vad_bytes)

    device = "cpu"  # build machines have no GPU; weights are device-agnostic
    whisperx.load_model(WHISPER_MODEL, device, compute_type="int8")
    # Only English is baked. Another language would download its alignment
    # model on first use — works, but slow once. Klira content is English.
    whisperx.load_align_model(language_code="en", device=device)
    pipeline = Pipeline.from_pretrained(
        DIARISATION_MODEL, use_auth_token=os.environ["HF_TOKEN"]
    )
    # from_pretrained returns None (not an exception) when the gated repo is
    # inaccessible — without this check the failure surfaces later as a bare
    # AttributeError inside whisperx.
    if pipeline is None:
        raise RuntimeError(
            f"Pipeline.from_pretrained({DIARISATION_MODEL!r}) returned None — "
            "the HF token cannot access the gated model. Accept the terms for "
            f"BOTH {' and '.join(GATED_REPOS)} under the token's account, and "
            "check the 'huggingface' Modal secret."
        )


gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    # ffmpeg is needed at runtime (whisperx.load_audio shells out to it).
    # The rest exist because faster-whisper pins av==11.*, which has no
    # wheel and builds PyAV from source against the ffmpeg headers.
    .apt_install(
        "ffmpeg",
        "pkg-config",
        "libavformat-dev",
        "libavcodec-dev",
        "libavdevice-dev",
        "libavutil-dev",
        "libavfilter-dev",
        "libswscale-dev",
        "libswresample-dev",
    )
    # The ML chain is fully pinned. Leave one member loose and pip's
    # newest-of-everything resolution picks combinations that break at
    # runtime (this has already happened once — torchaudio 2.11 dropped
    # set_audio_backend). Verified working together on Python 3.11.
    #  - torch/torchaudio 2.1.2: pyannote.audio 3.1.1 calls
    #    torchaudio.set_audio_backend, which modern torchaudio removed;
    #    2.1.2 is contemporary with pyannote 3.1.1 (Dec 2023) and still has
    #    the pre-removal audio-backend API. The default PyPI wheel is the
    #    cu121 build, which covers the A10G (sm_86).
    #  - ctranslate2 4.4.0: last release linked against cuDNN 8, which is
    #    what torch 2.1.2 bundles. 4.5+ needs cuDNN 9 and fails on GPU at
    #    runtime — no build-time check catches that one.
    #  - numpy 1.26.4: numpy 2.x breaks extensions compiled against 1.x.
    #  - faster-whisper / pyannote.audio: whisperx 3.1.5 pins both exactly;
    #    repeated here so nothing can shift them silently.
    # 3.1.5 keeps whisperx.DiarizationPipeline at the top level; newer
    # releases moved it and changed pyannote pins — retest diarisation
    # before bumping anything here.
    .pip_install(
        "torch==2.1.2",
        "torchaudio==2.1.2",
        "numpy==1.26.4",
        "ctranslate2==4.4.0",
        "faster-whisper==1.0.1",
        "pyannote.audio==3.1.1",
        "whisperx==3.1.5",
        "requests>=2.31",
    )
    # HF_HOME must match between build and runtime or the bake is useless.
    .env({"HF_HOME": MODELS_DIR})
    .run_function(_download_models, secrets=[modal.Secret.from_name("huggingface")])
)


def _diarise(result, audio, device: str, min_speakers, max_speakers):
    """Run pyannote diarisation and assign word speakers. Raises with a
    clear message on any failure — the caller decides whether to degrade."""
    import pandas as pd
    import torch
    import whisperx
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(
        DIARISATION_MODEL, use_auth_token=os.environ["HF_TOKEN"]
    )
    if pipeline is None:
        raise RuntimeError(
            f"Pipeline.from_pretrained({DIARISATION_MODEL!r}) returned None — "
            f"the HF token cannot access the gated model. Accept the terms for "
            f"BOTH {' and '.join(GATED_REPOS)} under the token's account, "
            "update the 'huggingface' Modal secret, and rebuild the image "
            "(bump bake_version in _download_models or MODAL_FORCE_BUILD=1)."
        )
    pipeline.to(torch.device(device))

    kwargs = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers
    annotation = pipeline(
        {"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": 16000},
        **kwargs,
    )
    diarize_df = pd.DataFrame(
        (
            (segment.start, segment.end, speaker)
            for segment, _, speaker in annotation.itertracks(yield_label=True)
        ),
        columns=["start", "end", "speaker"],
    )
    return whisperx.assign_word_speakers(diarize_df, result)


@app.function(
    image=gpu_image,
    gpu=GPU,
    timeout=60 * 60,
    secrets=[modal.Secret.from_name("huggingface")],
)
def transcribe(
    audio_url: str,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
    diarise: bool = True,
    language: str | None = "en",
) -> dict:
    import gc
    import tempfile

    import requests
    import torch
    import whisperx

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        with requests.get(audio_url, stream=True, timeout=120) as r:
            r.raise_for_status()
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
        audio_path = f.name

    device = "cuda"

    def _release(*models):
        for m in models:
            del m
        gc.collect()
        torch.cuda.empty_cache()

    model = whisperx.load_model(WHISPER_MODEL, device, compute_type="float16")
    audio = whisperx.load_audio(audio_path)
    # Klira content is English; short/quiet ads misdetect (observed: 'cy',
    # 'nn') and the aligner has no model for those. Force the language
    # unless the caller explicitly passes language=None for autodetect.
    result = model.transcribe(audio, batch_size=16, language=language)
    language = result["language"]
    _release(model)

    align_model, metadata = whisperx.load_align_model(
        language_code=language, device=device
    )
    result = whisperx.align(
        result["segments"], align_model, metadata, audio, device,
        return_char_alignments=False,
    )
    _release(align_model)

    # Diarisation is optional and NEVER fails the job: a broken token,
    # missing gated-model access, or a pyannote error degrades to a
    # transcript without speaker labels.
    speakers_assigned = False
    diarisation_error = None
    if diarise:
        try:
            result = _diarise(result, audio, device, min_speakers, max_speakers)
            speakers_assigned = True
        except Exception as exc:
            diarisation_error = f"{type(exc).__name__}: {exc}"
            print(f"diarisation failed — continuing without speaker labels: "
                  f"{diarisation_error}")
        finally:
            gc.collect()
            torch.cuda.empty_cache()

    return _build_payload(
        result, language, speakers_assigned, diarisation_error, len(audio)
    )


def _jsonable(value):
    """Recursively convert WhisperX output to plain JSON types. The return
    value crosses a Modal function boundary into the api container, which
    (deliberately) has no numpy — an np.float32 anywhere in the payload
    makes deserialisation fail there. Non-finite floats become None:
    starlette encodes with allow_nan=False, so a NaN score would 500 the
    /result poll."""
    import math

    import numpy as np

    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, np.ndarray):
        value = value.tolist()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _build_payload(
    result: dict,
    language: str,
    diarised: bool,
    diarisation_error: str | None,
    n_samples: int,
) -> dict:
    segments = [
        {
            "start": seg.get("start"),
            "end": seg.get("end"),
            "text": seg.get("text", "").strip(),
            "speaker": seg.get("speaker"),
            "words": [
                {
                    "word": w.get("word", "").strip(),
                    # Some words (numerals, noises) get no alignment; the
                    # schema allows null timings, so pass them through.
                    "start": w.get("start"),
                    "end": w.get("end"),
                    "score": w.get("score"),
                    "speaker": w.get("speaker"),
                }
                for w in seg.get("words", [])
            ],
        }
        for seg in result["segments"]
    ]

    payload = _jsonable({
        "engine": "whisperx",
        "model": WHISPER_MODEL,
        "language": language,
        "diarised": diarised,
        "diarisation_error": diarisation_error,
        "duration_s": round(n_samples / 16000.0, 3),
        "segments": segments,
    })
    # Fail HERE, with a traceback naming the offending value, rather than as
    # an opaque deserialisation error in the api container or a 500 on the
    # poll route. Matches starlette's encoder settings.
    json.dumps(payload, allow_nan=False)
    return payload


api_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi[standard]>=0.110"
)


_transcribe_handle = None


def _transcribe_fn():
    """Resolve the deployed GPU function by name. Inside the api container
    the module-level `transcribe` reference can be a plain function rather
    than a hydrated Modal handle (version-dependent), which makes
    `.spawn` blow up with AttributeError — from_name is the documented,
    version-robust way to call a deployed function."""
    global _transcribe_handle
    if _transcribe_handle is None:
        _transcribe_handle = modal.Function.from_name(app.name, "transcribe")
    return _transcribe_handle


@app.function(
    image=api_image,
    secrets=[modal.Secret.from_name("airtomic-transcribe-auth")],
)
@modal.asgi_app()
def api():
    from fastapi import FastAPI, HTTPException, Request

    web = FastAPI()

    def _check_auth(request: Request) -> None:
        expected = f"Bearer {os.environ['MODAL_TOKEN']}"
        supplied = request.headers.get("authorization", "")
        if not py_secrets.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="bad or missing bearer token")

    @web.post("/transcribe")
    async def submit(request: Request):
        _check_auth(request)
        body = await request.json()
        audio_url = body.get("audio_url")
        if not audio_url:
            raise HTTPException(status_code=400, detail="audio_url is required")
        call = _transcribe_fn().spawn(
            audio_url,
            min_speakers=body.get("min_speakers"),
            max_speakers=body.get("max_speakers"),
            diarise=body.get("diarise", True),
            language=body.get("language", "en"),
        )
        return {"call_id": call.object_id}

    @web.get("/result/{call_id}")
    async def result(call_id: str, request: Request):
        _check_auth(request)
        try:
            call = modal.FunctionCall.from_id(call_id)
            output = call.get(timeout=0)
        except TimeoutError:
            return {"status": "running"}
        except Exception as exc:  # remote failure surfaces here on .get()
            return {"status": "failed", "error": str(exc)}
        return {"status": "done", "result": output}

    return web
