"""Overlay ASS generation, safe-zone positioning, subtitle collision."""

from worker.overlays import (
    build_overlay_ass, overlay_band, overlay_vp, position_y,
    resolve_cfg, subtitle_shift_for,
)

STYLES = {
    "hook": {"font": "Plus Jakarta Sans", "weight": 800, "fs": 58,
             "color": "#FFFFFF", "box": True, "box_color": "#0A0B0D",
             "box_alpha": 0.78, "pad": 16},
    "cta": {"font": "Plus Jakarta Sans", "weight": 800, "fs": 44,
            "color": "#0A0B0D", "box": True, "box_color": "#FFC629",
            "box_alpha": 1.0, "pad": 16},
}


def OV(text="Hook line", start=0.0, end=3.0, position="top", style="hook",
       sv=None):
    return {"text": text, "start_s": start, "end_s": end,
            "position": position, "style": style, "sv": sv}


def SV(**over):
    base = {"fs": 44, "ol": 0, "vp": 76, "wpl": None, "color": "#FFFFFF",
            "bg": "pill", "bg_color": "#0A0B0D", "bg_alpha": 0.75,
            "caps": False, "weight": 800}
    base.update(over)
    return base


def test_positions_respect_9x16_safe_zones():
    assert position_y("top", "9x16") >= 0.14        # below the 14% chrome
    assert position_y("center", "9x16") == 0.5
    lt = position_y("lower_third", "9x16")
    assert 0.66 <= lt <= 0.84                        # above the 16% bottom zone


def test_ass_has_drawing_plus_text_event_per_bg_overlay():
    ass = build_overlay_ass([OV(), OV("CTA", 5, 8, "lower_third", "cta")],
                            STYLES, "9x16", 1080, 1920, 10.0)
    # background targets burn as a \p1 rounded-rect drawing UNDER the text
    assert ass.count("Dialogue:") == 4          # (drawing + text) x 2
    assert ass.count("\\p1}") == 2
    assert "Style: Ov0,Plus Jakarta Sans,58," in ass
    # hook: white text; dark box colour with alpha 0.78 -> 0x38 on the drawing
    assert "&H00FFFFFF&" in ass
    assert "\\1c&H380D0B0A&" in ass
    assert "\\1a&H38&" in ass
    # cta: opaque brand yellow drawing behind dark text
    assert "\\1c&H0029C6FF&" in ass
    # drawing on layer 1, its text above on layer 2, subtitles stay at 0
    assert "Dialogue: 1," in ass and "Dialogue: 2," in ass


def test_multiline_and_brace_escaping():
    ass = build_overlay_ass([OV("Line one\nLine {two}")], STYLES,
                            "9x16", 1080, 1920, 10.0)
    assert "Line one\\NLine (two)" in ass


def test_event_clamped_to_clip_duration_and_zero_len_dropped():
    ass = build_overlay_ass([OV(start=8, end=20), OV(start=12, end=15)],
                            STYLES, "9x16", 1080, 1920, 10.0)
    assert ass.count("Dialogue:") == 2               # drawing + text; 2nd overlay dropped
    assert "0:00:08.00,0:00:10.00" in ass


def test_fontsize_scales_with_output_width():
    a = build_overlay_ass([OV()], STYLES, "9x16", 1080, 1920, 10)
    b = build_overlay_ass([OV()], STYLES, "1.91x1", 1200, 628, 10)
    fs_a = int(a.split("Style: Ov0,Plus Jakarta Sans,")[1].split(",")[0])
    fs_b = int(b.split("Style: Ov0,Plus Jakarta Sans,")[1].split(",")[0])
    assert fs_a == 58 and fs_b == round(58 * 1200 / 1080)


def test_subtitles_pushed_down_only_when_colliding():
    # subtitle at 72%; lower_third overlay WITH a background -> collision
    ovs = [OV(position="lower_third", start=0, end=3)]
    shifted = subtitle_shift_for(1.0, 1.4, ovs, "9x16", 0.72, STYLES)
    band = overlay_band(overlay_vp(ovs[0], STYLES, "9x16"))
    assert shifted > band[1]                          # pushed below the overlay
    assert shifted <= 1 - 0.16 + 0.04 + 1e-9          # capped near the safe zone
    # outside the overlay's time window: untouched
    assert subtitle_shift_for(4.0, 4.4, ovs, "9x16", 0.72, STYLES) == 0.72
    # a top hook never collides with subtitles at 72%
    assert subtitle_shift_for(
        1.0, 1.4, [OV(position="top")], "9x16", 0.72, STYLES) == 0.72


def test_backgroundless_overlay_never_pushes_subtitles():
    # same band as the subtitle, but bg none: text over text is a design
    # choice, not a collision
    naked = OV(sv=SV(vp=72, bg="none"))
    assert subtitle_shift_for(1.0, 1.4, [naked], "9x16", 0.72) == 0.72
    # give it a pill and the same overlay pushes
    pilled = OV(sv=SV(vp=72, bg="pill"))
    assert subtitle_shift_for(1.0, 1.4, [pilled], "9x16", 0.72) > 0.72
    # a CENTRE overlay with no background: no push (the brief's example)
    centre = OV(sv=SV(vp=50, bg="none"))
    assert subtitle_shift_for(1.0, 1.4, [centre], "9x16", 0.72) == 0.72


def test_sv_drives_burn_style_and_position():
    ov = OV(sv=SV(fs=60, color="#FF6B8A", bg="box", bg_color="#14171C",
                  bg_alpha=1.0, vp=33))
    ass = build_overlay_ass([ov], {}, "9x16", 1080, 1920, 10)
    assert "Style: Ov0,Plus Jakarta Sans,60," in ass    # resolved fs, no preset
    assert "&H008A6BFF&" in ass                          # text colour BGR
    assert "&H001C1714&" in ass                          # opaque bg colour
    assert f"\\pos(540,{round(0.33 * 1920)})" in ass   # vp, not position enum
    # wpl rewrap: 5 words at wpl=2 -> two \N breaks
    wrapped = OV(text="one two three four five", sv=SV(wpl=2, vp=20))
    ass2 = build_overlay_ass([wrapped], {}, "9x16", 1080, 1920, 10)
    assert "one two\\Nthree four\\Nfive" in ass2


def test_unknown_style_key_falls_back_to_defaults():
    ass = build_overlay_ass([OV(style="nope")], {}, "9x16", 1080, 1920, 10)
    assert "Dialogue:" in ass
    assert "Style: Ov0," in ass


def test_pos_matches_stored_fractions_per_ratio():
    # 9:16 base at (30%, 40%), 1:1 override at (70%, 20%)
    ov = OV(sv=SV(vp=40, xp=30, w=60, pr={"1x1": {"xp": 70, "vp": 20, "w": 40}}))
    a916 = build_overlay_ass([ov], {}, "9x16", 1080, 1920, 10)
    assert f"\\pos({round(0.30 * 1080)},{round(0.40 * 1920)})" in a916
    a11 = build_overlay_ass([ov], {}, "1x1", 1080, 1080, 10)
    assert f"\\pos({round(0.70 * 1080)},{round(0.20 * 1080)})" in a11
    # a ratio WITHOUT its own placement defaults from the 9:16 base
    a45 = build_overlay_ass([ov], {}, "4x5", 1080, 1350, 10)
    assert f"\\pos({round(0.30 * 1080)},{round(0.40 * 1350)})" in a45


def test_width_wraps_deterministically_within_box():
    long = "your skin barrier needs less than you think it does honestly"
    narrow = build_overlay_ass([OV(long, sv=SV(vp=50, xp=50, w=40))], {}, "9x16", 1080, 1920, 10)
    wide = build_overlay_ass([OV(long, sv=SV(vp=50, xp=50, w=100))], {}, "9x16", 1080, 1920, 10)
    # text is pre-wrapped (\q2 + explicit \N) so the drawn box matches
    assert "\\q2\\pos" in narrow
    assert narrow.count("\\N") > wide.count("\\N")


def test_radius_shapes_the_drawing():
    r0 = build_overlay_ass([OV(sv=SV(vp=50, bg="pill", radius=0))], {}, "9x16", 1080, 1920, 10)
    r8 = build_overlay_ass([OV(sv=SV(vp=50, bg="pill", radius=8))], {}, "9x16", 1080, 1920, 10)
    d0 = next(l for l in r0.splitlines() if "\\p1}" in l)
    d8 = next(l for l in r8.splitlines() if "\\p1}" in l)
    assert " b " not in d0          # radius 0: plain rectangle
    assert " b " in d8              # radius: bezier corners
    # radius scales with output width like fs (8 at 1080 -> ~8.9 at 1200)
    r191 = build_overlay_ass([OV(sv=SV(vp=50, bg="pill", radius=40))], {}, "1.91x1", 1200, 628, 10)
    assert " b " in next(l for l in r191.splitlines() if "\\p1}" in l)


def test_collision_respects_horizontal_extent():
    # narrow pill parked at the left edge, same height as the subtitles:
    # its box misses the subtitle band horizontally -> no push-down... but
    # subtitles wrap near full width, so anything inside ~8-92% overlaps.
    # Park it fully OUTSIDE that span (impossible on-frame), so instead
    # verify a mid-frame narrow box DOES push and the vertical miss does not.
    low_left = OV(sv=SV(vp=72, xp=20, w=30, bg="pill"))
    assert subtitle_shift_for(1.0, 1.4, [low_left], "9x16", 0.72) > 0.72
    high_left = OV(sv=SV(vp=20, xp=20, w=30, bg="pill"))
    assert subtitle_shift_for(1.0, 1.4, [high_left], "9x16", 0.72) == 0.72


def test_zero_opacity_background_never_pushes():
    # geometry kept (pill), but 0% opacity: no push-down
    ghost = OV(sv=SV(vp=72, xp=50, w=80, bg="pill", bg_alpha=0.0))
    assert subtitle_shift_for(1.0, 1.4, [ghost], "9x16", 0.72) == 0.72
    # any opacity above 0 pushes
    faint = OV(sv=SV(vp=72, xp=50, w=80, bg="pill", bg_alpha=0.05))
    assert subtitle_shift_for(1.0, 1.4, [faint], "9x16", 0.72) > 0.72
    # burn: alpha byte on BackColour (0.0 -> FF fully transparent)
    ass = build_overlay_ass([ghost], {}, "9x16", 1080, 1920, 10)
    assert "&HFF0D0B0A&" in ass


def test_hex_to_ass_bgr_conversion():
    # ASS stores colours as &HAABBGGRR — a picked colour must land with
    # channels swapped: #3A7BD5 (R=3A G=7B B=D5) -> BBGGRR = D57B3A
    ov = OV(sv=SV(vp=50, color="#3A7BD5", bg="none", ol=3, ol_color="#10FF20"))
    ass = build_overlay_ass([ov], {}, "9x16", 1080, 1920, 10)
    assert "&H00D57B3A&" in ass          # PrimaryColour, BGR order
    assert "&H0020FF10&" in ass          # OutlineColour, BGR order


def test_font_family_burns_and_is_vendored():
    from pathlib import Path
    from worker.overlays import FONTS
    ov = OV(sv=SV(vp=50, font="Space Grotesk"))
    ass = build_overlay_ass([ov], {}, "9x16", 1080, 1920, 10)
    assert "Style: Ov0,Space Grotesk," in ass
    # unknown family never reaches the ASS — falls back to the default
    bad = OV(sv=SV(vp=50, font="Comic Sans MS"))
    assert "Comic Sans" not in build_overlay_ass([bad], {}, "9x16", 1080, 1920, 10)
    # every offered family has a vendored file in the worker image dir
    stems = " ".join(p.name for p in Path("worker/fonts").glob("*.ttf")).replace(" ", "")
    for fam in FONTS:
        assert fam.replace(" ", "") in stems, fam
