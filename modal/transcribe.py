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

import os
import secrets as py_secrets

import modal

WHISPER_MODEL = "large-v3"
GPU = "A10G"
MODELS_DIR = "/models"

app = modal.App("airtomic-transcribe")


def _download_models() -> None:
    """Bake model weights into the image at build time (see CLAUDE.md known
    traps) — otherwise every cold start re-downloads several GB."""
    import whisperx
    from pyannote.audio import Pipeline

    device = "cpu"  # build machines have no GPU; weights are device-agnostic
    whisperx.load_model(WHISPER_MODEL, device, compute_type="int8")
    # Only English is baked. Another language would download its alignment
    # model on first use — works, but slow once. Klira content is English.
    whisperx.load_align_model(language_code="en", device=device)
    Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1", use_auth_token=os.environ["HF_TOKEN"]
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
    # 3.1.5 keeps whisperx.DiarizationPipeline at the top level; newer
    # releases moved it and changed pyannote pins — retest diarisation
    # before bumping.
    .pip_install("whisperx==3.1.5", "requests>=2.31")
    # HF_HOME must match between build and runtime or the bake is useless.
    .env({"HF_HOME": MODELS_DIR})
    .run_function(_download_models, secrets=[modal.Secret.from_name("huggingface")])
)


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
    result = model.transcribe(audio, batch_size=16)
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

    diarize = whisperx.DiarizationPipeline(
        use_auth_token=os.environ["HF_TOKEN"], device=device
    )
    diarize_kwargs = {}
    if min_speakers is not None:
        diarize_kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        diarize_kwargs["max_speakers"] = max_speakers
    diarize_segments = diarize(audio, **diarize_kwargs)
    result = whisperx.assign_word_speakers(diarize_segments, result)
    _release(diarize)

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

    return {
        "engine": "whisperx",
        "model": WHISPER_MODEL,
        "language": language,
        "diarised": True,
        "duration_s": round(len(audio) / 16000.0, 3),
        "segments": segments,
    }


api_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "fastapi[standard]>=0.110"
)


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
        call = transcribe.spawn(
            audio_url,
            min_speakers=body.get("min_speakers"),
            max_speakers=body.get("max_speakers"),
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
