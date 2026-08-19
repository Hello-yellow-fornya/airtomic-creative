"""Phase 0 Meta backfill: the historical ad corpus, read with ads_read only.

    python -m worker.backfill                 # dry run: reads Meta, prints
                                              # the plan, writes NOTHING
    python -m worker.backfill --apply         # write ad_performance, copy
                                              # videos to R2, queue ingest
    python -m worker.backfill --apply --skip-media   # perf rows only
    python -m worker.backfill --since 2024-01-01 --until 2025-08-19 --apply
    python -m worker.backfill --limit 10 --apply     # first careful batch

What it does, in order:
 1. Lists every ad on the account with its creative's video reference(s).
 2. Pulls ad-level insights — RAW COUNTS ONLY (impressions, 3s/15s views,
    thruplays, quartiles, link clicks, spend, purchases, purchase value).
    Rates are never imported; video_performance computes them (CLAUDE.md §2).
 3. Joins ads to videos. An ad whose creative carries MULTIPLE videos
    (asset_feed_spec dynamic creative) is REPORTED AND SKIPPED — writing one
    spend row per video would double-count the ad's spend in the rollup.
    The summary lists every such ad so the de-duplication question
    (CLAUDE.md open question 1) gets answered with data.
 4. Upserts ad_performance keyed (ad_id, meta_video_id).
 5. For each distinct video not yet ingested: fetches the video node, copies
    the file to R2 IMMEDIATELY (Meta source URLs are short-lived — never
    stored or resolved on demand), and queues the normal ingest →
    scene detect → tag → recommend chain so the back catalogue gets the same
    treatment as long-form.

Needs META_APP_ID / META_APP_SECRET / META_SYSTEM_USER_TOKEN /
META_AD_ACCOUNT_ID plus the worker's DATABASE_URL and R2 env. ads_read is
sufficient — nothing here writes to Meta.
"""

import argparse
import json
import logging
import sys
import tempfile
import uuid
from typing import Any

import requests

from . import config, db, r2
from .meta import MetaClient, MetaError, video_ids_of_ad

log = logging.getLogger("worker.backfill")

# purchases can be reported under several action_types; take the first
# present, in this order, and record which was used.
PURCHASE_KEYS = ("omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase")


def _action(row: dict, key: str, field: str = "actions") -> int | None:
    for a in row.get(field) or []:
        if a.get("action_type") == key:
            try:
                return int(float(a["value"]))
            except (KeyError, TypeError, ValueError):
                return None
    return None


def _action_value(row: dict, key: str) -> float | None:
    for a in row.get("action_values") or []:
        if a.get("action_type") == key:
            try:
                return float(a["value"])
            except (KeyError, TypeError, ValueError):
                return None
    return None


def _video_metric(row: dict, field: str) -> int | None:
    """Fields like video_thruplay_watched_actions come back as an actions
    list with a single 'video_view' entry."""
    return _action(row, "video_view", field)


def _purchases(row: dict) -> tuple[int | None, float | None, str | None]:
    for key in PURCHASE_KEYS:
        n = _action(row, key)
        if n is not None:
            return n, _action_value(row, key), key
    return None, None, None


def _int(v) -> int | None:
    try:
        return int(float(v)) if v is not None else None
    except (TypeError, ValueError):
        return None


def _float(v) -> float | None:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def perf_row(insight: dict, meta_video_id: str) -> dict[str, Any]:
    purchases, purchase_value, purchase_key = _purchases(insight)
    return {
        "meta_video_id": meta_video_id,
        "ad_id": insight["ad_id"],
        "adset_id": insight.get("adset_id"),
        "campaign_id": insight.get("campaign_id"),
        "ad_name": insight.get("ad_name"),
        "objective": insight.get("objective"),
        "date_start": insight.get("date_start"),
        "date_stop": insight.get("date_stop"),
        "impressions": _int(insight.get("impressions")),
        "reach": _int(insight.get("reach")),
        "video_3s_views": _action(insight, "video_view"),
        "video_15s_views": _video_metric(insight, "video_15_sec_watched_actions"),
        "thruplays": _video_metric(insight, "video_thruplay_watched_actions"),
        "video_p25": _video_metric(insight, "video_p25_watched_actions"),
        "video_p50": _video_metric(insight, "video_p50_watched_actions"),
        "video_p75": _video_metric(insight, "video_p75_watched_actions"),
        "video_p100": _video_metric(insight, "video_p100_watched_actions"),
        "link_clicks": _action(insight, "link_click"),
        "spend": _float(insight.get("spend")),
        "purchases": purchases,
        "purchase_value": purchase_value,
        "currency": insight.get("account_currency"),
        # unified attribution was requested; record which purchase
        # action_type supplied the conversion counts
        "attribution_window": "unified"
                              + (f"/{purchase_key}" if purchase_key else ""),
    }


UPSERT_SQL = """
INSERT INTO ad_performance
    (meta_video_id, ad_id, adset_id, campaign_id, ad_name, objective,
     date_start, date_stop, impressions, reach, video_3s_views,
     video_15s_views, thruplays, video_p25, video_p50, video_p75,
     video_p100, link_clicks, spend, purchases, purchase_value,
     currency, attribution_window, synced_at)
VALUES (%(meta_video_id)s, %(ad_id)s, %(adset_id)s, %(campaign_id)s,
        %(ad_name)s, %(objective)s, %(date_start)s, %(date_stop)s,
        %(impressions)s, %(reach)s, %(video_3s_views)s, %(video_15s_views)s,
        %(thruplays)s, %(video_p25)s, %(video_p50)s, %(video_p75)s,
        %(video_p100)s, %(link_clicks)s, %(spend)s, %(purchases)s,
        %(purchase_value)s, %(currency)s, %(attribution_window)s, now())
ON CONFLICT (ad_id, meta_video_id) DO UPDATE SET
    adset_id = EXCLUDED.adset_id, campaign_id = EXCLUDED.campaign_id,
    ad_name = EXCLUDED.ad_name, objective = EXCLUDED.objective,
    date_start = EXCLUDED.date_start, date_stop = EXCLUDED.date_stop,
    impressions = EXCLUDED.impressions, reach = EXCLUDED.reach,
    video_3s_views = EXCLUDED.video_3s_views,
    video_15s_views = EXCLUDED.video_15s_views,
    thruplays = EXCLUDED.thruplays,
    video_p25 = EXCLUDED.video_p25, video_p50 = EXCLUDED.video_p50,
    video_p75 = EXCLUDED.video_p75, video_p100 = EXCLUDED.video_p100,
    link_clicks = EXCLUDED.link_clicks, spend = EXCLUDED.spend,
    purchases = EXCLUDED.purchases,
    purchase_value = EXCLUDED.purchase_value,
    currency = EXCLUDED.currency,
    attribution_window = EXCLUDED.attribution_window,
    synced_at = now()
"""


def fetch_video_to_r2(client: MetaClient, s3, bucket: str,
                      meta_video_id: str) -> tuple[str, str | None, float | None]:
    """Download the ad video and upload to R2 NOW — the source URL is
    short-lived. Returns (r2_uri, title, length_s)."""
    node = client.video_node(meta_video_id)
    source = node.get("source")
    if not source:
        raise MetaError(f"video {meta_video_id} has no downloadable source "
                        "(permission or expired asset)")
    key = f"sources/{uuid.uuid4()}/meta_{meta_video_id}.mp4"
    with tempfile.NamedTemporaryFile(suffix=".mp4") as tmp:
        with requests.get(source, stream=True, timeout=120) as resp:
            resp.raise_for_status()
            for chunk in resp.iter_content(1024 * 1024):
                tmp.write(chunk)
        tmp.flush()
        r2.upload_file(s3, bucket, key, tmp.name, "video/mp4")
    return r2.make_uri(bucket, key), node.get("title"), _float(node.get("length"))


def run(apply: bool, since: str | None, until: str | None,
        limit: int | None, skip_media: bool) -> int:
    cfg = config.load()
    missing = [n for n, v in (
        ("META_APP_ID", cfg.meta_app_id),
        ("META_APP_SECRET", cfg.meta_app_secret),
        ("META_SYSTEM_USER_TOKEN", cfg.meta_system_user_token),
        ("META_AD_ACCOUNT_ID", cfg.meta_ad_account_id),
    ) if not v]
    if missing:
        log.error("missing env: %s", ", ".join(missing))
        return 2

    client = MetaClient(
        app_id=cfg.meta_app_id, app_secret=cfg.meta_app_secret,
        access_token=cfg.meta_system_user_token,
        ad_account_id=cfg.meta_ad_account_id,
        api_version=cfg.meta_api_version,
    )

    log.info("listing ads with creatives…")
    ads = client.ads_with_creatives()
    if limit:
        ads = ads[:limit]
    ad_videos = {ad["id"]: video_ids_of_ad(ad) for ad in ads}
    single = {aid: vids[0] for aid, vids in ad_videos.items() if len(vids) == 1}
    multi = {aid: vids for aid, vids in ad_videos.items() if len(vids) > 1}
    no_video = [aid for aid, vids in ad_videos.items() if not vids]
    log.info("%s ads: %s single-video, %s multi-video (asset_feed_spec), "
             "%s without video", len(ads), len(single), len(multi), len(no_video))

    if multi:
        log.warning("MULTI-VIDEO ADS — skipped to avoid double-counting spend "
                    "in the video→ad join. These need a de-duplication "
                    "decision before their spend can be attributed:")
        for aid, vids in multi.items():
            name = next((a.get("name") for a in ads if a["id"] == aid), "?")
            log.warning("  ad %s (%s): videos %s", aid, name, ", ".join(vids))

    log.info("pulling ad-level insights (raw counts only)…")
    insights = client.insights_ad_level(since=since, until=until)
    rows = [perf_row(i, single[i["ad_id"]])
            for i in insights if i.get("ad_id") in single]
    skipped_perf = [i["ad_id"] for i in insights
                    if i.get("ad_id") in multi]
    log.info("%s insight rows total; %s joinable to a single video; "
             "%s belong to multi-video ads (skipped)",
             len(insights), len(rows), len(skipped_perf))

    wanted_videos = sorted({r["meta_video_id"] for r in rows})
    log.info("%s distinct videos referenced", len(wanted_videos))

    if not apply:
        log.info("DRY RUN — nothing written. Sample row:\n%s",
                 json.dumps(rows[0], indent=1, default=str) if rows else "(none)")
        log.info("re-run with --apply to write %s ad_performance rows and "
                 "%s videos%s", len(rows), len(wanted_videos),
                 " (media skipped)" if skip_media else "")
        return 0

    conn = db.connect(cfg.database_url)
    s3 = r2.client(cfg.r2_account_id, cfg.r2_access_key_id,
                   cfg.r2_secret_access_key)

    with conn.transaction():
        for r_ in rows:
            conn.execute(UPSERT_SQL, r_)
    log.info("wrote %s ad_performance rows", len(rows))

    if skip_media:
        log.info("media skipped (--skip-media) — done")
        return 0

    existing = {
        row["meta_video_id"]
        for row in conn.execute(
            "SELECT meta_video_id FROM videos WHERE meta_video_id IS NOT NULL"
        ).fetchall()
    }
    queued, failed = 0, []
    for mvid in wanted_videos:
        if mvid in existing:
            continue
        try:
            uri, title, _length = fetch_video_to_r2(client, s3, cfg.r2_bucket, mvid)
            vid, job_id = db.create_video_and_ingest_job(
                conn, storage_uri=uri,
                title=title or f"meta ad video {mvid}",
                source="ad_creative", uploaded_by="backfill",
                meta_video_id=mvid,
            )
            queued += 1
            log.info("queued %s as video %s (job %s)", mvid, vid, job_id)
        except (MetaError, requests.RequestException, OSError) as exc:
            # partial failure isolates: everything already queued stays
            failed.append((mvid, str(exc)))
            log.error("video %s failed: %s", mvid, exc)

    log.info("done: %s videos queued for ingest, %s already present, "
             "%s failed", queued, len(existing & set(wanted_videos)), len(failed))
    for mvid, err in failed:
        log.error("  failed %s: %s", mvid, err)
    return 1 if failed else 0


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s",
                        stream=sys.stdout)
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--apply", action="store_true",
                   help="actually write; default is a dry run")
    p.add_argument("--since", help="YYYY-MM-DD insights window start")
    p.add_argument("--until", help="YYYY-MM-DD insights window end")
    p.add_argument("--limit", type=int, help="cap the number of ads (first careful run)")
    p.add_argument("--skip-media", action="store_true",
                   help="write ad_performance only; don't fetch video files")
    args = p.parse_args()
    try:
        sys.exit(run(args.apply, args.since, args.until, args.limit,
                     args.skip_media))
    except MetaError as exc:
        log.error("meta api error: %s %s", exc, json.dumps(exc.detail))
        sys.exit(2)


if __name__ == "__main__":
    main()
