"""Pin the ffmpeg command builder: overlay track chaining and the
signature the render path actually calls (a silently-missed patch here
shipped a TypeError to production once)."""

from worker.render import _build_command

SCENES = [{
    "id": "s1", "idx": 0, "layout": "full",
    "source_in_s": 10.0, "source_out_s": 14.0, "duration_s": None,
    "slot_a_asset": None, "slot_b_asset": None,
    "split_ratio": None, "audio": "source",
}]


def cmd(overlay=None):
    return _build_command(
        SCENES, {}, {}, "/tmp/src.mp4", 16 / 9, 1080, 1920,
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
    c = _build_command(SCENES, {}, {}, "/s.mp4", 1.777, 1080, 1920,
                       "/a.ass", "/o.mp4", overlay_ass_path=None)
    assert c[0] == "ffmpeg" and "-filter_complex" in c
