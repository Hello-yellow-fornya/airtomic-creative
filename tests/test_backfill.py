"""Backfill mapping logic: video-id resolution (asset_feed_spec handled
explicitly), raw-count extraction, purchase key priority."""

from worker.backfill import _purchases, breakdown_row, perf_row
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


BREAKDOWN_INSIGHT = {
    "ad_id": "a9",
    "ad_name": "UF_Andy Ad2_H1: What if less skincare did more?_Video_19/08/2026",
    "impressions": "1850", "spend": "32.7555", "account_currency": "GBP",
    "actions": [
        {"action_type": "video_view", "value": "568"},
        {"action_type": "link_click", "value": "24"},
        {"action_type": "omni_purchase", "value": "2"},
    ],
    "action_values": [{"action_type": "omni_purchase", "value": "80.0"}],
    "video_asset": {"video_id": "3569047136587530",
                    "video_name": "ANDY_AD2_1-1_H1.mp4"},
}


def test_breakdown_row_per_video_raw_counts():
    row = breakdown_row(BREAKDOWN_INSIGHT)
    assert row["meta_video_id"] == "3569047136587530"
    assert row["impressions"] == 1850
    assert row["spend"] == 32.7555
    assert row["video_3s_views"] == 568
    assert row["purchases"] == 2 and row["purchase_value"] == 80.0
    assert "video_asset" in row["attribution_window"]


def test_breakdown_unavailable_metrics_stay_null():
    row = breakdown_row(BREAKDOWN_INSIGHT)
    # the breakdown does not expose these — never prorated from ad totals
    for k in ("video_15s_views", "thruplays", "video_p25", "video_p50",
              "video_p75", "video_p100"):
        assert row[k] is None


def test_merge_rows_sums_duplicate_pairs():
    from worker.backfill import merge_rows
    a = breakdown_row(BREAKDOWN_INSIGHT)                       # spend 32.7555
    b = breakdown_row({**BREAKDOWN_INSIGHT, "spend": "5859.79",
                       "impressions": "397830",
                       "actions": [{"action_type": "video_view", "value": "1000"}]})
    merged = merge_rows([a, b])
    assert len(merged) == 1
    m = merged[0]
    assert abs(m["spend"] - (32.7555 + 5859.79)) < 1e-6       # not last-write-wins
    assert m["impressions"] == 1850 + 397830
    assert m["video_3s_views"] == 568 + 1000
    assert m["purchases"] == 2                                # None in b → keeps a
    assert m["reach"] is None                                 # not additive
    # null-in-all stays null, never zero
    assert m["thruplays"] is None


def test_merge_rows_distinct_pairs_untouched():
    from worker.backfill import merge_rows
    a = breakdown_row(BREAKDOWN_INSIGHT)
    other = breakdown_row({**BREAKDOWN_INSIGHT, "ad_id": "a10"})
    merged = merge_rows([a, other])
    assert len(merged) == 2
    assert {m["ad_id"] for m in merged} == {"a9", "a10"}
    assert all(m["spend"] == 32.7555 for m in merged)


def test_merge_rows_widens_date_span():
    from worker.backfill import merge_rows
    a = breakdown_row({**BREAKDOWN_INSIGHT,
                       "date_start": "2024-05-01", "date_stop": "2025-01-01"})
    b = breakdown_row({**BREAKDOWN_INSIGHT,
                       "date_start": "2023-07-20", "date_stop": "2026-08-19"})
    m = merge_rows([a, b])[0]
    assert (m["date_start"], m["date_stop"]) == ("2023-07-20", "2026-08-19")


def test_breakdown_row_parses_both_names():
    parts = breakdown_row(BREAKDOWN_INSIGHT)["name_parts"]
    assert parts["ad"]["funnel_stage"] == "UF"
    assert parts["ad"]["hook"] == "H1"
    assert parts["video_name"] == "ANDY_AD2_1-1_H1.mp4"
    assert parts["video"]["rendition"] == "1x1"
    assert parts["video"]["concept_stem"] == "andy ad2 h1"
