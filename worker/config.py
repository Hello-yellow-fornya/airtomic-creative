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
    )
