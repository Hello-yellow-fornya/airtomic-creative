"""Reframe math: pinned to tests/fixtures/reframe.json — the SAME file the
web port is tested against, so preview and burn resolve identically."""

import json
from pathlib import Path

from worker.reframe import (
    clamp_transform, framed_high, transform_to_window, window_to_transform,
)

FIX = json.loads((Path(__file__).parent / "fixtures" / "reframe.json").read_text())


def test_windows_match_fixtures():
    for c in FIX["cases"]:
        w = transform_to_window(c["t"], c["srcW"], c["srcH"], c["frameW"], c["frameH"])
        for k in ("x", "y", "w", "h"):
            assert abs(w[k] - c["window"][k]) < 1e-9, (c["t"], k)


def test_clamp_matches_fixtures_and_holds_cover():
    for c in FIX["cases"]:
        cl = clamp_transform({**c["t"], "x": 9, "y": -9}, c["srcW"], c["srcH"], c["frameW"], c["frameH"])
        for k in ("x", "y", "scale"):
            assert abs(float(cl[k]) - float(c["clamped"][k])) < 1e-9, (c["t"], k)
        if cl.get("mode") != "fit":
            w = transform_to_window(cl, c["srcW"], c["srcH"], c["frameW"], c["frameH"])
            assert w["x"] >= -1e-9 and w["y"] >= -1e-9
            assert w["x"] + w["w"] <= 1 + 1e-9 and w["y"] + w["h"] <= 1 + 1e-9


def test_inverse_round_trip():
    for c in FIX["cases"]:
        if c["t"].get("mode") == "fit":
            continue
        inv = window_to_transform(c["window"], c["srcW"], c["srcH"], c["frameW"], c["frameH"])
        assert abs(inv["x"] - c["t"]["x"]) < 1e-9
        assert abs(inv["scale"] - c["t"]["scale"]) < 1e-9


def test_framed_high_puts_height_crop_at_top():
    t = framed_high(1920, 1080, 1200, 628)
    for k in ("x", "y", "scale"):
        assert abs(float(t[k]) - float(FIX["framed_high_1p91"][k])) < 1e-9
    win = transform_to_window(t, 1920, 1080, 1200, 628)
    assert abs(win["y"]) < 1e-9          # window top at source top
    # full-height ratios have no vertical freedom: framed high == centre
    assert framed_high(1920, 1080, 1080, 1920)["y"] == 0
