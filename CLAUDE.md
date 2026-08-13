# airtomic-creative

AI-assisted creative production for Klira (klira.skin). Ingests long-form content
(podcasts, Instagram Lives), transcribes it with word-level timing, recommends
segments worth cutting based on patterns in Klira's historical ad performance,
composes them into subtitled vertical creative, and pushes approved variants to
Meta as **paused** ads.

Single client. Klira only. No multi-tenancy.

---

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Web | Next.js 15 (App Router) on Vercel | UI + API routes |
| DB | Neon Postgres | migrations in `/migrations`, plain SQL |
| Storage | Cloudflare R2 | zero egress — matters for video |
| Jobs | `jobs` table, `FOR UPDATE SKIP LOCKED` | no pg-boss, no Redis |
| Worker | Python service (Railway) | scene detect, tag, render, push |
| GPU | Modal function | WhisperX only, called over HTTP |

**Why a Python worker rather than Node:** every heavy task is Python-native —
WhisperX, PySceneDetect, ffmpeg orchestration. pg-boss is Node-only, so the jobs
table does the queueing instead. Don't reintroduce pg-boss.

---

## Non-negotiable constraints

These are the decisions most likely to get quietly undone during a refactor.
Each one has a specific failure mode attached. Don't "simplify" past them.

### 1. Subtitle timing must be remapped after scene order resolves

Word timestamps live on the **source** timeline. Once a scene is reordered or
lifted, they no longer describe the output. The ASS file must be generated
*after* the scene list resolves, mapping each source word to its new output
position.

Failure mode: captions drift progressively, and nobody notices until someone
watches a whole clip.

Reference implementation: `outputWords()` in the prototype.

### 2. Never store computed rates

Thumbstop, hold rate, CTR, CPA, ROAS are **never** persisted pre-computed. One
video appears across many ads; averaging rates weights a £50 ad the same as a
£5,000 one. Store numerators and denominators, compute at the `video_performance`
rollup.

### 3. Separate ads, never dynamic creative

Each variant gets its own AdCreative and Ad in the same ad set. Do not use
`asset_feed_spec` to put multiple videos in one ad — that's the exact case where
the video→ad spend join double-counts and corrupts the learning loop.

### 4. Crops are per scene per ratio

`scene_crops` is keyed `(scene_id, ratio)`. A 9:16 crop does not transfer to 1:1 —
the square window is nearly twice as wide and pulls in the second speaker.

**1.91:1 is structurally different.** It's wider than a 16:9 source, so it crops
*height*, not width, and the reframe drag axis is vertical. Crop code that assumes
a horizontal window will silently produce the wrong frame.

Crop maths against a 16:9 source:

| Ratio | Window |
|---|---|
| 9:16 | 31.6% of width, full height |
| 4:5 | 45% of width, full height |
| 1:1 | 56.25% of width, full height |
| 1.91:1 | full width, 93.1% of height |

### 5. Recommendations carry their sample size

~78 Klira creatives have meaningful spend. That is not enough for causal claims.
Every surfaced pattern must show `n=` and its evidence, including where the
evidence is weak. Do not add a confident composite score without sample context —
false precision is worse than no ranking, because the team will believe it.

### 6. Nothing publishes

All pushed ads land `PAUSED`. The tool never creates campaigns or ad sets — it
only adds ads to ad sets that already exist. This is what makes a bug unable to
create spend.

### 7. Sending is not atomic

Variants that succeed stay created. Failures isolate.

- `failed` — upload/processing died at Meta. Creative is fine. **Retryable.**
- `rejected` — failed ad review. Retry is pointless; the creative must change.
  **Never offer retry on a rejected variant.**

---

## Data model

```
videos ──┬── transcripts ── transcript_segments ── transcript_words
         ├── scenes                    (detected cuts, keyframes)
         ├── creative_tags             (versioned JSONB)
         └── clip_candidates           (recommendation output)
                    │
clips ──── clip_variants ──── variant_scenes ──── scene_crops
                    │                                (one per ratio)
                    └── meta_pushes

assets            brand stills, end cards, logos, b-roll
ad_performance    raw counts from Airtomic → video_performance view
jobs              queue
```

A **clip** is a segment. A **variant** is one ad. Approval and sending both sit
on the variant, not the clip — each variant is reviewed and pushed independently.

Every table carries `client_id` despite being single-client. Costs nothing now,
avoids a miserable migration later.

Words are stored as **rows**, not JSON. A 90-minute podcast is ~13,000 words;
as rows every downstream feature is a normal SQL query.

---

## Composition model

A clip is not a trim. It's an ordered sequence of **scenes**, each with exactly
one **layout**. Content flows into named slots; nothing is free-positioned.

| Layout | Composition |
|---|---|
| `full` | source video, cropped to target ratio |
| `split_product` | speaker above, brand asset below |
| `split_speakers` | both speakers stacked |
| `card` | full-frame asset, no source video |

This follows Descript/Opus Clip, deliberately not CapCut-style overlay tracks —
free-positioned overlays can't be templated, so consistency would depend on
whoever was editing.

Defaults: highlights are **lifted** from their original position (not duplicated);
speaker audio wins in splits; split ratios are presets (50/50, 60/40), not free
resize.

Render is one ffmpeg `filter_complex`: normalise every input to the target
resolution at matching fps and pixel format, `vstack`/`overlay` for splits, then
concat. **The normalise step is not optional** — concat produces garbage when
inputs differ, and brand assets always will.

---

## Approval flow

```
draft → in_review → approved → sent
                              ↘ failed → (retry)
```

Building and approving are separate steps, modelled on invoice approval. The
person cutting clips isn't necessarily cleared to approve prescription claims.
Schema records `submitted_by` and `approved_by` separately.

Bulk actions in the queue are **scoped per state** — send only exists on the
approved tab, so an unapproved variant can't reach Meta by mis-click.

---

## Compliance

Klira is prescription skincare. UK rules around POM advertising are restrictive.

- The creative tagger raises a compliance flag on segments making treatment claims.
- Expect Meta ad review rejections more often than most categories.
- Surface the rejection reason per variant in-app, or the team hunts for it in
  Ads Manager.

---

## Known traps

- **pyannote is gated on Hugging Face.** Accept terms for *both*
  `speaker-diarization-3.1` and `segmentation-3.0` under the token-owning account,
  or diarisation fails at runtime with an unhelpful error.
- **Bake models into the container image.** Otherwise every cold start
  re-downloads several GB.
- **Render a 720p proxy on ingest.** Scrubbing a 4GB source in-browser is unusable.
- **Meta `source` URLs are short-lived.** Copy files to R2 on ingest, don't
  resolve on demand.
- **Shared Meta app ID = shared rate-limit bucket** with Airtomic. Ads Insights
  limits are account-scoped and unforgiving.
- **Vision tagging cost.** Scene-detect and composite keyframes into a single grid
  image, one call per video. Sending frames individually costs ~100× for no
  quality gain. This is the single largest cost lever in the build.
- **Extract audio to 16kHz mono WAV** before transcription.

---

## Conventions

- Migrations are plain SQL, numbered, forward-only. No ORM migrations.
- Ad naming: `KLR_{SOURCE}_{topic}_c{NN}_{LABEL}_{slug}` —
  e.g. `KLR_POD_barrier_c01_B_emotional-hook`
- `utm_content` mirrors the variant: `b_emotional-hook`. Without it Meta reports
  which hook won on click-through but GA4 can't attribute consultations.
- Timestamps in the DB are `timestamptz`. Durations are `numeric(10,3)` seconds.
- Crop values are normalised 0–1, never pixels — survives re-ingestion at a
  different resolution.

---

## Open questions

Unresolved. Don't invent answers; ask.

1. Do any Klira ads use dynamic creative / `asset_feed_spec`? Determines whether
   the video→ad join needs de-duplication.
2. Does Airtomic store video files or only IDs? If IDs only, we need our own fetch.
3. Same Meta app ID as Airtomic, or separate?
4. Confirmed attribution window, timezone, currency.
5. Which ad set is the creative-testing target?
6. **1.91:1 is a Google PMax size but sending only targets Meta.** Does PMax need
   a Google Ads asset-library push, or is a download for manual upload enough?
7. Should approval enforce `approved_by != submitted_by`?
8. Cap on variants per send?

---

## Reference

`docs/prototype.html` — clickable UI reference. Not production code: no real
video, no API calls, sample data throughout. It does implement the subtitle
remap correctly, so use it as the reference for that specifically.

Placeholder transcript quotes in the prototype are invented and attributed to a
real named person. Replace before any external circulation.
