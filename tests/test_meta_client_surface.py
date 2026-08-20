"""Pin the MetaClient surface the webapp and backfill depend on.

Regression for the /meta/diag outage: an edit inserted a module-level
function between class methods, silently orphaning diag() as dead code
inside another function — the route then died with AttributeError on
every request. Attribute checks catch that class of mistake at test time.
"""

from worker.meta import MetaClient


def test_client_has_every_method_the_callers_use():
    c = MetaClient(app_id="1", app_secret="s", access_token="t",
                   ad_account_id="123", api_version="v26.0")
    for name in (
        # webapp /meta/diag
        "diag", "debug_token", "version_check", "account_info",
        "campaigns", "adsets", "accessible_ad_accounts",
        # backfill
        "ads_with_creatives", "insights_ad_level", "insights_video_asset",
        "video_node", "get", "get_all",
    ):
        assert callable(getattr(c, name, None)), f"MetaClient.{name} missing"


def test_diag_without_account_lists_accessible_accounts(monkeypatch):
    c = MetaClient(app_id="1", app_secret="s", access_token="t",
                   ad_account_id="", api_version="v26.0")
    called = []
    monkeypatch.setattr(c, "debug_token", lambda: called.append("token") or {})
    monkeypatch.setattr(c, "version_check", lambda: called.append("version") or {})
    monkeypatch.setattr(c, "accessible_ad_accounts",
                        lambda: called.append("accounts") or [])
    out = c.diag()
    assert set(out) == {"token", "version", "accessible_ad_accounts"}
    assert called == ["token", "version", "accounts"]


def test_diag_with_account_checks_campaigns_and_adsets(monkeypatch):
    c = MetaClient(app_id="1", app_secret="s", access_token="t",
                   ad_account_id="act_9", api_version="v26.0")
    for name in ("debug_token", "version_check", "account_info",
                 "campaigns", "adsets"):
        monkeypatch.setattr(c, name, lambda n=name: {"ran": n})
    out = c.diag()
    assert set(out) == {"token", "version", "account", "campaigns", "adsets"}
