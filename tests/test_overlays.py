"""Overlay ASS generation, safe-zone positioning, subtitle collision."""

from worker.overlays import (
    build_overlay_ass, overlay_band, position_y, subtitle_shift_for,
)

STYLES = {
    "hook": {"font": "Plus Jakarta Sans", "weight": 800, "fs": 58,
             "color": "#FFFFFF", "box": True, "box_color": "#0A0B0D",
             "box_alpha": 0.78, "pad": 16},
    "cta": {"font": "Plus Jakarta Sans", "weight": 800, "fs": 44,
            "color": "#0A0B0D", "box": True, "box_color": "#FFC629",
            "box_alpha": 1.0, "pad": 16},
}


def OV(text="Hook line", start=0.0, end=3.0, position="top", style="hook"):
    return {"text": text, "start_s": start, "end_s": end,
            "position": position, "style": style}


def test_positions_respect_9x16_safe_zones():
    assert position_y("top", "9x16") >= 0.14        # below the 14% chrome
    assert position_y("center", "9x16") == 0.5
    lt = position_y("lower_third", "9x16")
    assert 0.66 <= lt <= 0.84                        # above the 16% bottom zone


def test_ass_has_style_and_event_per_overlay():
    ass = build_overlay_ass([OV(), OV("CTA", 5, 8, "lower_third", "cta")],
                            STYLES, "9x16", 1080, 1920, 10.0)
    assert ass.count("Dialogue:") == 2
    assert "Style: Ov0,Plus Jakarta Sans,58," in ass
    # hook: white text, dark box with alpha (0.78 -> a=56 -> 0x38)
    assert "&H00FFFFFF&" in ass
    assert "&H380D0B0A&" in ass
    # cta: opaque brand yellow box behind dark text
    assert "&H0029C6FF&" in ass
    # overlays sit on layer 1, above the subtitle layer 0
    assert "Dialogue: 1," in ass


def test_multiline_and_brace_escaping():
    ass = build_overlay_ass([OV("Line one\nLine {two}")], STYLES,
                            "9x16", 1080, 1920, 10.0)
    assert "Line one\\NLine (two)" in ass


def test_event_clamped_to_clip_duration_and_zero_len_dropped():
    ass = build_overlay_ass([OV(start=8, end=20), OV(start=12, end=15)],
                            STYLES, "9x16", 1080, 1920, 10.0)
    assert ass.count("Dialogue:") == 1               # second is fully past the end
    assert "0:00:08.00,0:00:10.00" in ass


def test_fontsize_scales_with_output_width():
    a = build_overlay_ass([OV()], STYLES, "9x16", 1080, 1920, 10)
    b = build_overlay_ass([OV()], STYLES, "1.91x1", 1200, 628, 10)
    fs_a = int(a.split("Style: Ov0,Plus Jakarta Sans,")[1].split(",")[0])
    fs_b = int(b.split("Style: Ov0,Plus Jakarta Sans,")[1].split(",")[0])
    assert fs_a == 58 and fs_b == round(58 * 1200 / 1080)


def test_subtitles_pushed_down_only_when_colliding():
    # subtitle at 72%; lower_third overlay occupies ~73-83% -> collision
    ovs = [OV(position="lower_third", start=0, end=3)]
    shifted = subtitle_shift_for(1.0, 1.4, ovs, "9x16", 0.72)
    band = overlay_band("lower_third", "9x16")
    assert shifted > band[1]                          # pushed below the overlay
    assert shifted <= 1 - 0.16 + 0.04 + 1e-9          # capped near the safe zone
    # outside the overlay's time window: untouched
    assert subtitle_shift_for(4.0, 4.4, ovs, "9x16", 0.72) == 0.72
    # a top hook never collides with subtitles at 72%
    assert subtitle_shift_for(1.0, 1.4, [OV(position="top")], "9x16", 0.72) == 0.72


def test_unknown_style_key_falls_back_to_defaults():
    ass = build_overlay_ass([OV(style="nope")], {}, "9x16", 1080, 1920, 10)
    assert "Dialogue:" in ass
    assert "Style: Ov0," in ass
