import os
from dataclasses import dataclass

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    database_url: str
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket: str
    modal_transcribe_url: str
    modal_token: str
    poll_interval_s: float
    concurrency: int
    ingest_token: str | None   # gates the web trigger; unset disables it
    port: int                  # Railway injects PORT
    anthropic_api_key: str | None  # required by the tag stage only
    anthropic_model: str
    diarise: bool                  # speaker labels are a nice-to-have
    # Meta Marketing API — all optional; the worker runs without them and
    # the send path reports "not configured" instead of crashing.
    meta_app_id: str | None
    meta_app_secret: str | None
    meta_system_user_token: str | None
    meta_ad_account_id: str | None
    meta_page_id: str | None
    meta_instagram_actor_id: str | None
    meta_api_version: str


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required env var: {name}")
    return value


def load() -> Config:
    load_dotenv()
    return Config(
        database_url=_require("DATABASE_URL"),
        r2_account_id=_require("R2_ACCOUNT_ID"),
        r2_access_key_id=_require("R2_ACCESS_KEY_ID"),
        r2_secret_access_key=_require("R2_SECRET_ACCESS_KEY"),
        r2_bucket=_require("R2_BUCKET"),
        modal_transcribe_url=_require("MODAL_TRANSCRIBE_URL").rstrip("/"),
        modal_token=_require("MODAL_TOKEN"),
        poll_interval_s=int(os.environ.get("WORKER_POLL_INTERVAL_MS", "2000")) / 1000,
        concurrency=int(os.environ.get("WORKER_CONCURRENCY", "2")),
        ingest_token=os.environ.get("INGEST_TOKEN") or None,
        port=int(os.environ.get("PORT", "8080")),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY") or None,
        anthropic_model=os.environ.get("ANTHROPIC_MODEL", "claude-opus-5"),
        diarise=os.environ.get("DIARISE", "true").lower() != "false",
        meta_app_id=os.environ.get("META_APP_ID") or None,
        meta_app_secret=os.environ.get("META_APP_SECRET") or None,
        meta_system_user_token=os.environ.get("META_SYSTEM_USER_TOKEN") or None,
        meta_ad_account_id=os.environ.get("META_AD_ACCOUNT_ID") or None,
        meta_page_id=os.environ.get("META_PAGE_ID") or None,
        meta_instagram_actor_id=os.environ.get("META_INSTAGRAM_ACTOR_ID") or None,
        meta_api_version=os.environ.get("META_API_VERSION", "v26.0"),
    )
