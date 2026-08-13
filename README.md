# airtomic-creative

AI-assisted creative production for Klira. Turns long-form content (podcasts,
Instagram Lives) into subtitled vertical ad creative, recommended from patterns
in historical ad performance, and pushed to Meta as paused ads.

See [CLAUDE.md](./CLAUDE.md) for architecture, constraints and open questions.
See [docs/prototype.html](./docs/prototype.html) for the UI reference.

## Layout

```
migrations/    plain SQL, numbered, forward-only
web/           Next.js 15 app (Vercel) — not built yet
worker/        Python worker — ingest today; scene detect, tag, render, push later
modal/         Modal GPU function for WhisperX
scripts/       CLI utilities (upload_video.py)
docs/          brief + clickable prototype
```

## Setup

```bash
cp .env.example .env        # fill in
for f in migrations/*.sql; do psql $DATABASE_URL -v ON_ERROR_STOP=1 -f "$f"; done
```

### Modal (WhisperX)

```bash
pip install modal && modal setup
modal secret create huggingface HF_TOKEN=<token>          # see .env.example for the pyannote gotcha
modal secret create airtomic-transcribe-auth MODAL_TOKEN=<random>
modal deploy modal/transcribe.py                          # prints the URL for MODAL_TRANSCRIBE_URL
```

The first deploy bakes model weights (several GB) into the image, so it is
slow once; cold starts after that don't download anything.

### Worker

```bash
pip install -r worker/requirements.txt    # plus ffmpeg on the machine
python -m worker.main
```

On Railway: deploy with `worker/Dockerfile`, build context at the repo root.

### Ingest a video

```bash
python scripts/upload_video.py path/to/podcast.mp4 --title "Ep 12"
```

Uploads to R2 via presigned URLs (multipart above 64 MiB), inserts the
`videos` row, and queues an `ingest` job. The worker picks it up: probes
metadata, extracts 16kHz mono WAV, transcribes on Modal, writes
`transcripts` / `transcript_segments` / `transcript_words`.

## Constraints worth knowing before you touch anything

- Subtitles are generated **after** scene order resolves, never before
- Performance rates are computed at query time, never stored
- One ad per variant — never `asset_feed_spec`
- Crops are stored per scene per output ratio
- All pushed ads land paused

Full detail in [CLAUDE.md](./CLAUDE.md).
