# airtomic-creative

AI-assisted creative production for Klira. Turns long-form content (podcasts,
Instagram Lives) into subtitled vertical ad creative, recommended from patterns
in historical ad performance, and pushed to Meta as paused ads.

See [CLAUDE.md](./CLAUDE.md) for architecture, constraints and open questions.
See [docs/prototype.html](./docs/prototype.html) for the UI reference.

## Layout

```
migrations/    plain SQL, numbered, forward-only
web/           Next.js 15 app (Vercel)
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

On Railway:

1. New Project → Deploy from GitHub repo → pick this repo and branch.
2. Service Settings → Build: Builder **Dockerfile**, Dockerfile path
   `worker/Dockerfile`. Leave the root directory at `/` — the build context
   must be the repo root or the worker package won't copy.
3. Variables: `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `MODAL_TRANSCRIBE_URL`,
   `MODAL_TOKEN`, `INGEST_TOKEN`, `ANTHROPIC_API_KEY` (creative tagging;
   optional `ANTHROPIC_MODEL` overrides the default `claude-opus-5`).
   Railway injects `PORT` itself.
4. Settings → Networking → **Generate Domain** so the web trigger is
   reachable. Logs should show `worker up` and `web trigger listening`.

### Web app

On Vercel: **Add New Project** → import this repo → set **Root Directory**
to `web` → add env var `DATABASE_URL` (the Neon string) → Deploy. The app
runs on that alone, but the full product needs `WORKER_URL` +
`INGEST_TOKEN` too: they power the server-side presign proxies
(`/api/keyframes`, `/api/media`, `/api/assets/.../file`, `/api/exports`)
that play real footage in the builder and preview, plus browser upload and
URL ingest from the Library screen. The token never reaches the browser;
raw footage stays off public URLs.

Locally:

```bash
cd web && npm install
DATABASE_URL=... npm run dev     # or npm run build && npm start
```

Videos list -> transcript with word-level timing and scene timeline ->
select a passage (click first word, click last word) -> clip + variant +
9x16 render job in one action. The clips page tracks render status and
export URIs; the variant editor handles layouts, split presets, asset
slots, per-scene-per-ratio reframing, reordering, and re-renders.

### Ingest a video

**From a URL (primary):** open `https://<worker-domain>/?key=<INGEST_TOKEN>`
in a browser, paste a source URL — a direct .mp4/.mp3 link or an episode
page (fetched with yt-dlp) — and submit. The page lists recent videos with
live status. Or hit the endpoint directly:

```bash
curl -X POST https://<worker-domain>/ingest \
  -d "key=<INGEST_TOKEN>" -d "url=https://example.com/ep12.mp4" -d "title=Ep 12"
```

**From a local file (browser):** the same worker page has an upload form —
the browser PUTs straight to R2 via presigned URLs (multipart above
64 MiB), then the worker completes the upload and queues ingest. One-time
setup: the R2 bucket needs a CORS rule (Cloudflare dashboard → R2 → bucket
→ Settings → CORS policy):

```json
[
  {
    "AllowedOrigins": ["https://<worker-domain>", "https://<vercel-domain>"],
    "AllowedMethods": ["PUT", "GET"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Without `ExposeHeaders: ETag` multipart uploads fail — the browser can't
read part ETags. `GET` + the Vercel origin lets the clip builder's
filmstrip draw real frames from the source video (it falls back to neutral
tiles without it; playback itself doesn't need CORS).

**From a local file (CLI):**

```bash
python scripts/upload_video.py path/to/podcast.mp4 --title "Ep 12"
```

Either way the `videos` row is inserted and an `ingest` job queued. The
worker picks it up: fetches/archives the source into R2, probes metadata,
extracts 16kHz mono WAV, transcribes on Modal, writes `transcripts` /
`transcript_segments` / `transcript_words`.

## Constraints worth knowing before you touch anything

- Subtitles are generated **after** scene order resolves, never before
- Performance rates are computed at query time, never stored
- One ad per variant — never `asset_feed_spec`
- Crops are stored per scene per output ratio
- All pushed ads land paused

Full detail in [CLAUDE.md](./CLAUDE.md).
