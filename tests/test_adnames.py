"""Ad/video name parsing against real names from the Klira account."""

from worker.adnames import parse_ad_name, parse_video_name


def test_current_convention_full():
    p = parse_ad_name("UF_Andy Ad2_H1: What if less skincare did more?_Video_19/08/2026")
    assert p["funnel_stage"] == "UF"
    assert p["theme"] == "Andy Ad2"
    assert p["hook"] == "H1"
    assert p["hook_text"] == "What if less skincare did more?"
    assert p["format"] == "Video"
    assert p["date_start"] == "2026-08-19"
    assert "date_end" not in p


def test_lf_static_with_date():
    p = parse_ad_name("LF_LO-FI Q&A AD MAY - H4_Static_12/08/2026")
    assert p["funnel_stage"] == "LF"
    assert p["theme"] == "LO-FI Q&A AD MAY - H4"
    assert p["hook"] == "H4"
    assert p["format"] == "Static"
    assert p["date_start"] == "2026-08-12"


def test_date_range():
    p = parse_ad_name("LF_Promo_Spring  Reset_Bundle_20/03/2026 - 30/03/2026")
    assert p["date_start"] == "2026-03-20"
    assert p["date_end"] == "2026-03-30"


def test_old_convention_degrades_gracefully():
    p = parse_ad_name("Conversions_FBIG_Launch_Interest_Testimonials Execution 2 Video")
    # no leading stage token, no H-number, no date — nothing invented
    assert "funnel_stage" not in p
    assert "hook" not in p
    assert "date_start" not in p


def test_no_stage_no_theme():
    assert "theme" not in parse_ad_name("ASC_FBIG_Skin Size_Interest_Boxing day sale")


def test_empty_and_none():
    assert parse_ad_name(None) == {}
    assert parse_ad_name("") == {}


def test_bad_date_rejected():
    assert "date_start" not in parse_ad_name("LF_x_Static_45/13/2026")


def test_video_rendition_pair_shares_stem():
    a = parse_video_name("ANDY_AD2_1-1_H1.mp4")
    b = parse_video_name("ANDY_AD2_9-16_H1.mp4")
    assert a["rendition"] == "1x1"
    assert b["rendition"] == "9x16"
    assert a["concept_stem"] == b["concept_stem"]


def test_video_rendition_x_separator_and_prefix():
    a = parse_video_name("AD Emma talking video 1 - 1x1.mp4")
    b = parse_video_name("1-1 KATIE FINAL AD.mp4")
    assert a["rendition"] == "1x1"
    assert b["rendition"] == "1x1"
    assert "katie final ad" in b["concept_stem"]


def test_video_name_without_ratio():
    p = parse_video_name("Range Video.mp4")
    assert "rendition" not in p
    assert p["concept_stem"] == "range video"
