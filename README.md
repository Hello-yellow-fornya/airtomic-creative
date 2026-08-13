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
worker/        Python worker — scene detect, tag, render, push
modal/         Modal GPU function for WhisperX
docs/          brief + clickable prototype
```

## Setup

```bash
cp .env.example .env        # fill in
psql $DATABASE_URL -f migrations/0001_extensions.sql
# ...run each migration in order
```

Or all at once:

```bash
for f in migrations/*.sql; do psql $DATABASE_URL -v ON_ERROR_STOP=1 -f "$f"; done
```

## Constraints worth knowing before you touch anything

- Subtitles are generated **after** scene order resolves, never before
- Performance rates are computed at query time, never stored
- One ad per variant — never `asset_feed_spec`
- Crops are stored per scene per output ratio
- All pushed ads land paused

Full detail in [CLAUDE.md](./CLAUDE.md).
