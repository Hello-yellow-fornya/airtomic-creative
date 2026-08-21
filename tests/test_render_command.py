"""Pin the ffmpeg command builder: overlay track chaining, the reframe
window derivation, and the signature the render path actually calls (a
silently-missed patch here shipped a TypeError to production once)."""

from worker.reframe import DEFAULT_TRANSFORM, transform_to_window
from worker.render import _build_command

SCENES = [{
    "id": "s1", "idx": 0, "layout": "full",
    "source_in_s": 10.0, "source_out_s": 14.0, "duration_s": None,
    "slot_a_asset": None, "slot_b_asset": None,
    "split_ratio": None, "audio": "source",
}]


def cmd(overlay=None, transform=None, fw=1080, fh=1920):
    return _build_command(
        SCENES, transform or dict(DEFAULT_TRANSFORM), {}, "/tmp/src.mp4",
        1920, 1080, fw, fh,
        "/tmp/subs.ass", "/tmp/out.mp4", overlay_ass_path=overlay,
    )


def test_without_overlays_single_ass_pass():
    fc = cmd()[cmd().index("-filter_complex") + 1]
    assert "ass=/tmp/subs.ass" in fc
    assert "overlays.ass" not in fc
    assert "[vout]" in fc


def test_with_overlays_chained_above_subtitles():
    c = cmd("/tmp/overlays.ass")
    fc = c[c.index("-filter_complex") + 1]
    # subtitles first, overlays composited after (on top)
    assert "ass=/tmp/subs.ass[vsub]" in fc
    assert "[vsub]ass=/tmp/overlays.ass[vout]" in fc
    assert fc.index("subs.ass") < fc.index("overlays.ass")


def test_positional_call_shape_stays_stable():
    # the exact call render_variant makes — keyword overlay_ass_path
    c = _build_command(SCENES, dict(DEFAULT_TRANSFORM), {}, "/s.mp4",
                       1920, 1080, 1080, 1920,
                       "/a.ass", "/o.mp4", overlay_ass_path=None)
    assert c[0] == "ffmpeg" and "-filter_complex" in c


def test_transform_window_reaches_the_crop_filter():
    t = {"x": 0.12, "y": -0.05, "scale": 1.4, "mode": "cover", "fit_color": "#000"}
    win = transform_to_window(t, 1920, 1080, 1080, 1920)
    fc = cmd(transform=t)[cmd(transform=t).index("-filter_complex") + 1]
    assert f"iw*{win['x']:.5f}" in fc
    assert f"crop=floor(iw*{win['w']:.5f}/2)*2" in fc
    # a different frame resolves a different window from the SAME transform
    win11 = transform_to_window(t, 1920, 1080, 1080, 1080)
    fc11 = cmd(transform=t, fw=1080, fh=1080)[
        cmd(transform=t, fw=1080, fh=1080).index("-filter_complex") + 1]
    assert f"iw*{win11['x']:.5f}" in fc11
    assert abs(win["w"] - win11["w"]) > 0.01  # genuinely per ratio


def test_fit_mode_letterboxes_with_brand_colour():
    t = {"x": 0, "y": 0, "scale": 1, "mode": "fit", "fit_color": "#FFC629"}
    fc = cmd(transform=t)[cmd(transform=t).index("-filter_complex") + 1]
    assert "force_original_aspect_ratio=decrease" in fc
    assert "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0xFFC629" in fc
    assert "crop=floor" not in fc
