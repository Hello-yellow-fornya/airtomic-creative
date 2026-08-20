"""Phase 0 Meta backfill: the historical ad corpus, read with ads_read only.

    python -m worker.backfill                 # dry run: reads Meta, prints
                                              # the plan, writes NOTHING
    python -m worker.backfill --apply         # write ad_performance, copy
                                              # videos to R2, queue ingest
    python -m worker.backfill --apply --skip-media   # perf rows only
    python -m worker.backfill --apply --min-spend 500  # only fetch videos
                                              # with >= £500 attributed spend
    python -m worker.backfill --limit 10 --apply     # first careful batch

How the video→ad join works (validated against the live account):

 PRIMARY — insights with breakdowns=video_asset. Klira runs placement-
 customised asset_feed_spec ads (two renditions of one creative per ad),
 so the creative object alone can't attribute spend per video. The
 video_asset breakdown returns per-(ad, video) delivery straight from
 Meta: impressions, spend, 3-second views, clicks, purchases — RAW COUNTS
 ONLY, no double-counting, covering every asset-feed ad that delivered.
 LIMITATION: 15s views, thruplays and quartiles are NOT available under
 this breakdown; those columns stay NULL on breakdown rows (null, never
 zero, never prorated from ad totals).

 LEGACY — pre-asset-feed ads (single video on the creative) don't appear
 in the breakdown. They join directly on the creative's video id via
 plain ad-level insights, which DO carry the full video metric set.

 Anything else with video plays but no attribution path is REPORTED, not
 guessed. Statics and catalogue/DPA ads are out of scope by nature.

Names are parsed at import (worker/adnames.py): funnel stage, theme, hook,
format and date from the ad name; rendition ratio and concept stem from the
video filename ("ANDY_AD2_1-1_H1.mp4" / "ANDY_AD2_9-16_H1.mp4" are one
creative). Stored in ad_performance.name_parts; the raw names stay in
ad_name / name_parts.video_name.

Video files are copied to R2 at fetch time (Meta source URLs are
short-lived) and queued through the normal ingest → scene detect → tag →
recommend chain. Partial failure isolates. Dry run is the default.
"""

import argparse
import json
import logging
import sys
import tempfile
import uuid
from typing import Any

import requests

from . import adnames, config, db, r2
from .meta import MetaClient, MetaError, video_ids_of_ad

log = logging.getLogger("worker.backfill")

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


def _base_row(insight: dict, meta_video_id: str) -> dict[str, Any]:
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
        "link_clicks": _action(insight, "link_click"),
        "spend": _float(insight.get("spend")),
        "purchases": purchases,
        "purchase_value": purchase_value,
        "currency": insight.get("account_currency"),
        "_purchase_key": purchase_key,
    }


def perf_row(insight: dict, meta_video_id: str) -> dict[str, Any]:
    """Full-metric row from PLAIN ad-level insights (legacy single-video
    ads): 15s/thruplay/quartiles are available here."""
    row = _base_row(insight, meta_video_id)
    row.update({
        "video_15s_views": _video_metric(insight, "video_15_sec_watched_actions"),
        "thruplays": _video_metric(insight, "video_thruplay_watched_actions"),
        "video_p25": _video_metric(insight, "video_p25_watched_actions"),
        "video_p50": _video_metric(insight, "video_p50_watched_actions"),
        "video_p75": _video_metric(insight, "video_p75_watched_actions"),
        "video_p100": _video_metric(insight, "video_p100_watched_actions"),
        "attribution_window": "unified"
                              + (f"/{row['_purchase_key']}" if row["_purchase_key"] else ""),
        "name_parts": _name_parts(insight.get("ad_name"), None),
    })
    row.pop("_purchase_key")
    return row


def breakdown_row(insight: dict) -> dict[str, Any]:
    """Per-(ad, video) row from the video_asset breakdown. The breakdown
    does not expose 15s/thruplay/quartiles — those stay NULL, never
    prorated from the ad's totals."""
    va = insight.get("video_asset") or {}
    row = _base_row(insight, str(va.get("video_id")))
    row.update({
        "video_15s_views": None,
        "thruplays": None,
        "video_p25": None, "video_p50": None,
        "video_p75": None, "video_p100": None,
        "attribution_window": "unified/video_asset"
                              + (f"/{row['_purchase_key']}" if row["_purchase_key"] else ""),
        "name_parts": _name_parts(insight.get("ad_name"), va.get("video_name")),
    })
    row.pop("_purchase_key")
    return row


def _name_parts(ad_name: str | None, video_name: str | None) -> dict:
    parts: dict[str, Any] = {}
    ad = adnames.parse_ad_name(ad_name)
    if ad:
        parts["ad"] = ad
    if video_name:
        parts["video_name"] = video_name
        vid = adnames.parse_video_name(video_name)
        if vid:
            parts["video"] = vid
    return parts


UPSERT_SQL = """
INSERT INTO ad_performance
    (meta_video_id, ad_id, adset_id, campaign_id, ad_name, objective,
     date_start, date_stop, impressions, reach, video_3s_views,
     video_15s_views, thruplays, video_p25, video_p50, video_p75,
     video_p100, link_clicks, spend, purchases, purchase_value,
     currency, attribution_window, name_parts, synced_at)
VALUES (%(meta_video_id)s, %(ad_id)s, %(adset_id)s, %(campaign_id)s,
        %(ad_name)s, %(objective)s, %(date_start)s, %(date_stop)s,
        %(impressions)s, %(reach)s, %(video_3s_views)s, %(video_15s_views)s,
        %(thruplays)s, %(video_p25)s, %(video_p50)s, %(video_p75)s,
        %(video_p100)s, %(link_clicks)s, %(spend)s, %(purchases)s,
        %(purchase_value)s, %(currency)s, %(attribution_window)s,
        %(name_parts)s, now())
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
    name_parts = EXCLUDED.name_parts,
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


def build_plan(client: MetaClient, since: str | None, until: str | None,
               limit: int | None) -> dict[str, Any]:
    """All the Meta reads: returns rows to write, videos to fetch, and the
    coverage report. Pure reads, no DB, no writes anywhere."""
    log.info("listing ads with creatives…")
    ads = client.ads_with_creatives()
    if limit:
        ads = ads[:limit]
    ad_ids = {ad["id"] for ad in ads}
    ad_videos = {ad["id"]: video_ids_of_ad(ad) for ad in ads}
    single = {aid: vids[0] for aid, vids in ad_videos.items() if len(vids) == 1}

    log.info("pulling insights with breakdowns=video_asset (per-video raw counts)…")
    bd = client.insights_video_asset(since=since, until=until)
    bd = [r for r in bd if (r.get("video_asset") or {}).get("video_id")
          and (not limit or r.get("ad_id") in ad_ids)]
    bd_ads = {r["ad_id"] for r in bd}
    rows = [breakdown_row(r) for r in bd]

    log.info("pulling plain ad-level insights (legacy single-video ads)…")
    plain = client.insights_ad_level(since=since, until=until)
    if limit:
        plain = [r for r in plain if r.get("ad_id") in ad_ids]
    legacy = [perf_row(r, single[r["ad_id"]]) for r in plain
              if r.get("ad_id") in single and r.get("ad_id") not in bd_ads]
    rows += legacy

    # honesty sweep: ads with video plays that neither path attributes
    unattributed = [
        {"ad_id": r["ad_id"], "ad_name": r.get("ad_name"),
         "spend": _float(r.get("spend")),
         "video_3s_views": _action(r, "video_view")}
        for r in plain
        if (_action(r, "video_view") or 0) > 0
        and r.get("ad_id") not in bd_ads
        and r.get("ad_id") not in single
    ]

    spend_by_video: dict[str, float] = {}
    for r_ in rows:
        spend_by_video[r_["meta_video_id"]] = (
            spend_by_video.get(r_["meta_video_id"], 0.0) + (r_["spend"] or 0.0))

    concepts: dict[str, list[str]] = {}
    for r_ in rows:
        stem = ((r_["name_parts"].get("video") or {}).get("concept_stem")
                if r_["name_parts"] else None)
        if stem:
            concepts.setdefault(stem, [])
            if r_["meta_video_id"] not in concepts[stem]:
                concepts[stem].append(r_["meta_video_id"])

    return {
        "ads_total": len(ads),
        "breakdown_rows": len(bd),
        "breakdown_ads": len(bd_ads),
        "legacy_rows": len(legacy),
        "rows": rows,
        "unattributed": unattributed,
        "spend_by_video": spend_by_video,
        "concepts": concepts,
    }


def handle(conn, cfg, s3, job: dict[str, Any]) -> None:
    """The `backfill` job: run an APPLY on the worker, which holds the
    R2 + Meta env. Enqueued deliberately (never by the pipeline); payload
    keys: limit, min_spend, skip_media, since, until."""
    p = job["payload"]
    code = run(
        apply=True,
        since=p.get("since"), until=p.get("until"),
        limit=int(p["limit"]) if p.get("limit") is not None else None,
        skip_media=bool(p.get("skip_media")),
        min_spend=float(p.get("min_spend") or 0),
        conn=conn, s3=s3, cfg=cfg,
    )
    if code != 0:
        raise MetaError(f"backfill finished with failures (exit {code}) — "
                        "see worker logs; successes are kept")


def run(apply: bool, since: str | None, until: str | None,
        limit: int | None, skip_media: bool, min_spend: float,
        conn=None, s3=None, cfg=None) -> int:
    cfg = cfg or config.load()
    missing = [n for n, v in (
        ("META_APP_ID", cfg.meta_app_id),
        ("META_APP_SECRET", cfg.meta_app_secret),
        ("META_SYSTEM_USER_TOKEN", cfg.meta_system_user_token),
    ) if not v]
    if missing:
        log.error("missing env: %s", ", ".join(missing))
        return 2

    account_id = cfg.meta_ad_account_id
    if not account_id:
        # Single-client tool: when the env var is absent but the token can
        # reach exactly one ad account, that account is unambiguous. More
        # than one (or none) still errors — never guess between accounts.
        probe = MetaClient(
            app_id=cfg.meta_app_id, app_secret=cfg.meta_app_secret,
            access_token=cfg.meta_system_user_token,
            ad_account_id="", api_version=cfg.meta_api_version,
        )
        accounts = probe.accessible_ad_accounts()
        if len(accounts) != 1:
            log.error("META_AD_ACCOUNT_ID unset and token reaches %s accounts"
                      " — set the env var", len(accounts))
            return 2
        account_id = accounts[0]["id"]
        log.warning("META_AD_ACCOUNT_ID unset — using the token's sole "
                    "accessible account %s (%s)", account_id,
                    accounts[0].get("name"))

    client = MetaClient(
        app_id=cfg.meta_app_id, app_secret=cfg.meta_app_secret,
        access_token=cfg.meta_system_user_token,
        ad_account_id=account_id,
        api_version=cfg.meta_api_version,
    )

    plan = build_plan(client, since, until, limit)
    rows = plan["rows"]
    spend_by_video = plan["spend_by_video"]
    wanted = sorted(v for v, s in spend_by_video.items() if s >= min_spend)
    total_spend = sum(r_["spend"] or 0 for r_ in rows)
    multi_rendition = sum(1 for vids in plan["concepts"].values() if len(vids) > 1)

    log.info(
        "coverage: %s ads scanned · %s per-video rows from the video_asset "
        "breakdown (%s ads) · %s legacy single-video rows · £%.0f attributed "
        "video spend · %s distinct videos (%s over the £%.0f media floor) · "
        "%s concept stems (%s spanning multiple renditions)",
        plan["ads_total"], plan["breakdown_rows"], plan["breakdown_ads"],
        plan["legacy_rows"], total_spend, len(spend_by_video), len(wanted),
        min_spend, len(plan["concepts"]), multi_rendition,
    )
    if plan["unattributed"]:
        log.warning("%s ad(s) show video plays but no attribution path — "
                    "reported, not guessed:", len(plan["unattributed"]))
        for u in plan["unattributed"]:
            log.warning("  ad %s (%s): £%.2f spend, %s 3s views",
                        u["ad_id"], u["ad_name"], u["spend"] or 0,
                        u["video_3s_views"])

    if not apply:
        log.info("DRY RUN — nothing written. Sample breakdown row:\n%s",
                 json.dumps(rows[0], indent=1, default=str) if rows else "(none)")
        log.info("re-run with --apply to write %s ad_performance rows and "
                 "fetch %s videos%s", len(rows), len(wanted),
                 " (media skipped)" if skip_media else "")
        return 0

    conn = conn or db.connect(cfg.database_url)
    s3 = s3 or r2.client(cfg.r2_account_id, cfg.r2_access_key_id,
                         cfg.r2_secret_access_key)

    with conn.transaction():
        for r_ in rows:
            conn.execute(UPSERT_SQL, {**r_, "name_parts":
                         json.dumps(r_["name_parts"]) if r_["name_parts"] else None})
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
    for mvid in wanted:
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
            failed.append((mvid, str(exc)))
            log.error("video %s failed: %s", mvid, exc)

    log.info("done: %s videos queued for ingest, %s already present, "
             "%s failed", queued, len(existing & set(wanted)), len(failed))
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
    p.add_argument("--min-spend", type=float, default=0.0,
                   help="only fetch video files with at least this much attributed spend")
    args = p.parse_args()
    try:
        sys.exit(run(args.apply, args.since, args.until, args.limit,
                     args.skip_media, args.min_spend))
    except MetaError as exc:
        log.error("meta api error: %s %s", exc, json.dumps(exc.detail))
        sys.exit(2)


if __name__ == "__main__":
    main()
