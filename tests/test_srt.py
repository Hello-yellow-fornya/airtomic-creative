"""SRT sidecar: same output_words remap as the ASS burn-in, so a lifted or
reordered scene produces identical timing in both."""

from worker.subtitles import _srt_ts, build_srt, output_words


def W(word, start, end):
    return {"word": word, "start": start, "end": end}


def test_timestamp_format():
    assert _srt_ts(0) == "00:00:00,000"
    assert _srt_ts(3661.25) == "01:01:01,250"
    assert _srt_ts(59.9994) == "00:00:59,999"


def test_cues_group_by_wpl_and_never_overlap():
    words = [W(f"w{i}", i * 1.0, i * 1.0 + 0.8) for i in range(5)]
    srt = build_srt(words, wpl=2)
    blocks = [b for b in srt.split("\n\n") if b.strip()]
    assert len(blocks) == 3           # 2 + 2 + 1 words
    assert blocks[0].splitlines()[0] == "1"
    assert "00:00:00,000 --> 00:00:01,800" in blocks[0]
    assert blocks[0].splitlines()[2] == "w0 w1"
    assert "00:00:02,000 --> 00:00:03,800" in blocks[1]
    assert blocks[2].splitlines()[2] == "w4"


def test_overlapping_lines_truncate_to_next_cue():
    # last word of line 1 runs past the first word of line 2
    words = [W("a", 0, 0.5), W("b", 0.6, 3.0), W("c", 1.0, 1.5), W("d", 1.6, 2.0)]
    srt = build_srt(words, wpl=2)
    blocks = [b for b in srt.split("\n\n") if b.strip()]
    end_1 = blocks[0].splitlines()[1].split(" --> ")[1]
    start_2 = blocks[1].splitlines()[1].split(" --> ")[0]
    assert end_1 <= start_2


def test_lifted_scene_matches_ass_source_timeline_remap():
    """A clip whose second scene is LIFTED from earlier in the source:
    words must land on the OUTPUT timeline, same as the burn-in."""
    scenes = [
        {"layout": "full", "source_in_s": 100.0, "source_out_s": 104.0},
        {"layout": "full", "source_in_s": 10.0, "source_out_s": 12.0},  # lifted
    ]
    words = [
        W("late", 100.5, 101.0),   # scene 1 → output 0.5-1.0
        W("early", 10.2, 10.9),    # scene 2 → output 4.2-4.9
    ]
    out = output_words(scenes, words)
    srt = build_srt(out, wpl=1)
    assert "00:00:00,500 --> 00:00:01,000\nlate" in srt
    assert "00:00:04,200 --> 00:00:04,900\nearly" in srt


def test_word_spanning_scene_boundary_sorted_before_grouping():
    scenes = [
        {"layout": "full", "source_in_s": 0.0, "source_out_s": 2.0},
        {"layout": "full", "source_in_s": 1.5, "source_out_s": 4.0},
    ]
    # this word overlaps BOTH scenes, so output_words emits it twice,
    # out of order relative to scene-2's earlier words
    words = [W("x", 0.2, 0.6), W("span", 1.8, 2.2), W("y", 3.0, 3.5)]
    out = output_words(scenes, words)
    srt = build_srt(out, wpl=1)
    times = [l.split(" --> ")[0] for l in srt.splitlines() if "-->" in l]
    assert times == sorted(times)


def test_empty_words_gives_empty_srt():
    assert build_srt([], wpl=4) == ""
