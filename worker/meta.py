"""Meta Marketing API client.

READ-ONLY for now: token introspection, version check, campaign/ad-set
listing. The send path (video upload → AdCreative → paused Ad) is built on
top of this module only after the diagnostics below have been reviewed
against the live account.

Ground rules that will bind the send path (from CLAUDE.md):
- never create campaigns or ad sets — only add ads to existing ad sets;
- one ad per variant, never asset_feed_spec;
- everything lands PAUSED.
"""

import logging
from typing import Any

import requests

log = logging.getLogger("worker.meta")

GRAPH = "https://graph.facebook.com"
TIMEOUT = 30


class MetaError(RuntimeError):
    """Graph API error with Meta's own diagnostic fields attached."""

    def __init__(self, message: str, detail: dict | None = None):
        super().__init__(message)
        self.detail = detail or {}


def _err_from_response(resp: requests.Response) -> MetaError:
    try:
        err = resp.json().get("error", {})
    except Exception:
        err = {}
    return MetaError(
        err.get("message") or f"HTTP {resp.status_code}",
        {
            "type": err.get("type"),
            "code": err.get("code"),
            "error_subcode": err.get("error_subcode"),
            "error_user_title": err.get("error_user_title"),
            "error_user_msg": err.get("error_user_msg"),
            "fbtrace_id": err.get("fbtrace_id"),
            "http_status": resp.status_code,
        },
    )


class MetaClient:
    def __init__(
        self,
        app_id: str,
        app_secret: str,
        access_token: str,
        ad_account_id: str,
        api_version: str,
        page_id: str | None = None,
        instagram_actor_id: str | None = None,
    ):
        self.app_id = app_id
        self.app_secret = app_secret
        self.token = access_token
        # accept the id with or without the act_ prefix
        self.account = (
            ad_account_id if ad_account_id.startswith("act_")
            else f"act_{ad_account_id}"
        )
        # normalise "26.0" / "v26.0" / "V26.0" alike
        self.version = f"v{api_version.strip().lstrip('vV')}"
        self.page_id = page_id
        self.instagram_actor_id = instagram_actor_id

    # -- low level -----------------------------------------------------

    def get(self, path: str, params: dict | None = None) -> dict:
        p = {"access_token": self.token, **(params or {})}
        resp = requests.get(
            f"{GRAPH}/{self.version}/{path.lstrip('/')}", params=p, timeout=TIMEOUT
        )
        if not resp.ok:
            raise _err_from_response(resp)
        return resp.json()

    def get_all(self, path: str, params: dict, cap: int = 500) -> list[dict]:
        """Follow paging.next until exhausted or cap reached."""
        out: list[dict] = []
        data = self.get(path, params)
        while True:
            out.extend(data.get("data", []))
            nxt = data.get("paging", {}).get("next")
            if not nxt or len(out) >= cap:
                return out[:cap]
            resp = requests.get(nxt, timeout=TIMEOUT)
            if not resp.ok:
                raise _err_from_response(resp)
            data = resp.json()

    # -- diagnostics ---------------------------------------------------

    def debug_token(self) -> dict:
        """Introspect the access token with an app token — reports scopes,
        granular scopes, type and expiry. This is the ads_management /
        business_management check."""
        resp = requests.get(
            f"{GRAPH}/{self.version}/debug_token",
            params={
                "input_token": self.token,
                "access_token": f"{self.app_id}|{self.app_secret}",
            },
            timeout=TIMEOUT,
        )
        if not resp.ok:
            raise _err_from_response(resp)
        d = resp.json().get("data", {})
        return {
            "is_valid": d.get("is_valid"),
            "type": d.get("type"),
            "application": d.get("application"),
            "app_id": d.get("app_id"),
            "app_id_matches": str(d.get("app_id")) == str(self.app_id),
            "scopes": d.get("scopes", []),
            "granular_scopes": d.get("granular_scopes", []),
            # 0 = never expires (typical for system user tokens)
            "expires_at": d.get("expires_at"),
            "data_access_expires_at": d.get("data_access_expires_at"),
            "issued_at": d.get("issued_at"),
        }

    def version_check(self) -> dict:
        """Confirm the configured Graph version actually exists. Meta has no
        'list versions' endpoint, so: (1) make a trivial versioned call and
        capture any 'unknown version' error verbatim; (2) make the same call
        unversioned and read the facebook-api-version response header, which
        names the version Meta itself chose to serve."""
        out: dict[str, Any] = {"configured": self.version}
        resp = requests.get(
            f"{GRAPH}/{self.version}/me",
            params={"access_token": self.token, "fields": "id,name"},
            timeout=TIMEOUT,
        )
        out["configured_version_ok"] = resp.ok
        out["served_as"] = resp.headers.get("facebook-api-version")
        if not resp.ok:
            try:
                out["error"] = resp.json().get("error", {})
            except Exception:
                out["error"] = {"http_status": resp.status_code}
        un = requests.get(
            f"{GRAPH}/me",
            params={"access_token": self.token, "fields": "id"},
            timeout=TIMEOUT,
        )
        out["unversioned_served_as"] = un.headers.get("facebook-api-version")
        return out

    def campaigns(self) -> list[dict]:
        return self.get_all(
            f"{self.account}/campaigns",
            {
                "fields": "id,name,status,effective_status,objective,"
                          "daily_budget,lifetime_budget,buying_type,"
                          "special_ad_categories,created_time",
                "limit": 100,
            },
        )

    def adsets(self) -> list[dict]:
        return self.get_all(
            f"{self.account}/adsets",
            {
                "fields": "id,name,campaign_id,status,effective_status,"
                          "daily_budget,lifetime_budget,optimization_goal,"
                          "billing_event,bid_strategy,created_time",
                "limit": 100,
            },
        )

    def accessible_ad_accounts(self) -> list[dict]:
        """Ad accounts this token can act on — the fallback read when
        META_AD_ACCOUNT_ID is missing or wrong."""
        return self.get_all(
            "me/adaccounts",
            {"fields": "id,name,account_status,currency,timezone_name",
             "limit": 100},
        )

    def account_info(self) -> dict:
        return self.get(
            self.account,
            {"fields": "id,name,account_status,currency,timezone_name"},
        )

    # -- backfill reads (ads_read is sufficient for all of these) -------

    def ads_with_creatives(self, limit_total: int = 2000) -> list[dict]:
        """Every ad on the account with its creative's video reference(s).
        asset_feed_spec is fetched explicitly so multi-video ads can be
        detected and reported rather than silently double-counted."""
        return self.get_all(
            f"{self.account}/ads",
            {
                "fields": "id,name,status,effective_status,adset_id,campaign_id,"
                          "created_time,"
                          "creative{id,video_id,object_type,object_story_spec,"
                          "asset_feed_spec}",
                "limit": 100,
            },
            cap=limit_total,
        )

    def insights_ad_level(
        self,
        since: str | None = None,
        until: str | None = None,
        limit_total: int = 2000,
    ) -> list[dict]:
        """Ad-level insights, RAW COUNTS ONLY — rates are computed at the
        video_performance rollup, never imported (CLAUDE.md §2). Lifetime
        aggregate per ad unless a since/until window is given."""
        params: dict = {
            "level": "ad",
            "fields": "ad_id,ad_name,adset_id,campaign_id,objective,"
                      "impressions,reach,spend,account_currency,"
                      "actions,action_values,"
                      "video_thruplay_watched_actions,"
                      "video_15_sec_watched_actions,"
                      "video_p25_watched_actions,video_p50_watched_actions,"
                      "video_p75_watched_actions,video_p100_watched_actions,"
                      "date_start,date_stop",
            "use_unified_attribution_setting": "true",
            "limit": 100,
        }
        if since or until:
            import json as _json
            params["time_range"] = _json.dumps(
                {"since": since or "2000-01-01",
                 "until": until or "2100-01-01"})
        else:
            params["date_preset"] = "maximum"
        return self.get_all(f"{self.account}/insights", params, cap=limit_total)

    def insights_video_asset(
        self,
        since: str | None = None,
        until: str | None = None,
        limit_total: int = 5000,
    ) -> list[dict]:
        """Ad-level insights broken down by video asset — per-(ad, video)
        raw counts for placement-customised asset_feed ads, where the
        creative object alone can't attribute spend per video. The
        breakdown exposes impressions/spend/actions but NOT the
        video_*_watched fields; callers must leave those NULL."""
        params: dict = {
            "level": "ad",
            "breakdowns": "video_asset",
            "fields": "ad_id,ad_name,adset_id,campaign_id,objective,"
                      "impressions,reach,spend,account_currency,"
                      "actions,action_values,date_start,date_stop",
            "use_unified_attribution_setting": "true",
            "limit": 200,
        }
        if since or until:
            import json as _json
            params["time_range"] = _json.dumps(
                {"since": since or "2000-01-01",
                 "until": until or "2100-01-01"})
        else:
            params["date_preset"] = "maximum"
        return self.get_all(f"{self.account}/insights", params, cap=limit_total)

    def video_node(self, meta_video_id: str) -> dict:
        """The ad video's metadata including its (short-lived) source URL —
        callers must copy the file to R2 immediately, never store the URL."""
        return self.get(
            meta_video_id,
            {"fields": "id,title,source,length,created_time"},
        )


def video_ids_of_ad(ad: dict) -> list[str]:
    """Every distinct video id an ad's creative references. One id is the
    normal case; several means asset_feed_spec dynamic creative — the exact
    case where a video→ad spend join double-counts, so callers must handle
    len > 1 explicitly, never average over it."""
    creative = ad.get("creative") or {}
    ids: list[str] = []

    def add(v):
        if v and str(v) not in ids:
            ids.append(str(v))

    add(creative.get("video_id"))
    oss = creative.get("object_story_spec") or {}
    add((oss.get("video_data") or {}).get("video_id"))
    afs = creative.get("asset_feed_spec") or {}
    for vid in afs.get("videos") or []:
        add((vid or {}).get("video_id"))
    return ids

    def diag(self) -> dict:
        """The full read-only proof: token scopes, version, account,
        campaigns and ad sets. Never writes anything."""
        checks: list[tuple[str, Any]] = [
            ("token", self.debug_token),
            ("version", self.version_check),
        ]
        if self.account != "act_":   # META_AD_ACCOUNT_ID present
            checks += [
                ("account", self.account_info),
                ("campaigns", self.campaigns),
                ("adsets", self.adsets),
            ]
        else:
            checks.append(("accessible_ad_accounts", self.accessible_ad_accounts))
        out: dict[str, Any] = {}
        for key, fn in checks:
            try:
                out[key] = fn()
            except MetaError as exc:
                out[key] = {"error": str(exc), **exc.detail}
            except requests.RequestException as exc:
                out[key] = {"error": f"network: {exc}"}
        return out
