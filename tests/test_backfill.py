"""Backfill mapping logic: video-id resolution (asset_feed_spec handled
explicitly), raw-count extraction, purchase key priority."""

from worker.backfill import _purchases, perf_row
from worker.meta import video_ids_of_ad


def test_video_ids_plain_creative():
    assert video_ids_of_ad({"creative": {"video_id": "111"}}) == ["111"]


def test_video_ids_object_story_spec():
    ad = {"creative": {"object_story_spec": {"video_data": {"video_id": "222"}}}}
    assert video_ids_of_ad(ad) == ["222"]


def test_video_ids_dedupes_same_video_across_fields():
    ad = {"creative": {
        "video_id": "333",
        "object_story_spec": {"video_data": {"video_id": "333"}},
    }}
    assert video_ids_of_ad(ad) == ["333"]


def test_asset_feed_spec_multiple_videos_all_reported():
    ad = {"creative": {"asset_feed_spec": {
        "videos": [{"video_id": "444"}, {"video_id": "555"}],
    }}}
    assert video_ids_of_ad(ad) == ["444", "555"]   # len>1 → caller must skip


def test_no_video_ad():
    assert video_ids_of_ad({"creative": {"object_type": "SHARE"}}) == []
    assert video_ids_of_ad({}) == []


INSIGHT = {
    "ad_id": "a1", "ad_name": "KLR_POD_x", "adset_id": "s1",
    "campaign_id": "c1", "objective": "OUTCOME_SALES",
    "impressions": "10000", "reach": "8000", "spend": "123.45",
    "account_currency": "GBP",
    "date_start": "2024-01-01", "date_stop": "2025-08-19",
    "actions": [
        {"action_type": "video_view", "value": "5000"},
        {"action_type": "link_click", "value": "300"},
        {"action_type": "omni_purchase", "value": "12"},
        {"action_type": "purchase", "value": "999"},   # must NOT win over omni
    ],
    "action_values": [{"action_type": "omni_purchase", "value": "480.50"}],
    "video_thruplay_watched_actions": [{"action_type": "video_view", "value": "2000"}],
    "video_15_sec_watched_actions": [{"action_type": "video_view", "value": "2500"}],
    "video_p25_watched_actions": [{"action_type": "video_view", "value": "4000"}],
    "video_p50_watched_actions": [{"action_type": "video_view", "value": "3000"}],
    "video_p75_watched_actions": [{"action_type": "video_view", "value": "2200"}],
    "video_p100_watched_actions": [{"action_type": "video_view", "value": "1500"}],
}


def test_perf_row_raw_counts_only():
    row = perf_row(INSIGHT, "vid9")
    assert row["meta_video_id"] == "vid9"
    assert row["impressions"] == 10000
    assert row["video_3s_views"] == 5000
    assert row["video_15s_views"] == 2500
    assert row["thruplays"] == 2000
    assert (row["video_p25"], row["video_p50"], row["video_p75"], row["video_p100"]) \
        == (4000, 3000, 2200, 1500)
    assert row["link_clicks"] == 300
    assert row["spend"] == 123.45
    assert row["purchases"] == 12          # omni_purchase wins
    assert row["purchase_value"] == 480.50
    assert row["currency"] == "GBP"
    assert "omni_purchase" in row["attribution_window"]
    # no computed rate sneaks in
    assert not any("rate" in k or k in ("ctr", "cpa", "roas") for k in row)


def test_purchase_key_fallback_order():
    n, v, key = _purchases({"actions": [{"action_type": "purchase", "value": "7"}],
                            "action_values": []})
    assert (n, key) == (7, "purchase")
    n, v, key = _purchases({"actions": [], "action_values": []})
    assert (n, v, key) == (None, None, None)


def test_missing_metrics_are_null_not_zero():
    row = perf_row({"ad_id": "a2", "impressions": "50"}, "vidX")
    assert row["impressions"] == 50
    assert row["video_3s_views"] is None    # absent ≠ zero
    assert row["purchases"] is None
    assert row["spend"] is None
