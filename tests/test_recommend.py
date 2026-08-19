"""Pure-function coverage for the content scorer: boundary snapping,
length enforcement, dedupe, evidence honesty."""

from worker.recommend import (
    EVIDENCE_LINE, MAX_CANDIDATES, _prepare_rows, _snap,
)

WORD_STARTS = [0.0, 1.0, 2.0, 10.0, 11.5, 24.8, 40.0, 55.0]
WORD_ENDS = [0.9, 1.9, 2.9, 10.9, 12.4, 25.7, 40.9, 55.9]


def cand(start, end, score=0.8, **kw):
    base = {
        "start_s": start, "end_s": end, "score": score,
        "opening_type": "question", "rationale": "why",
        "first_words": "a b c", "last_words": "x y z",
        "single_speaker_open": True,
        "treatment_claim": False, "treatment_claim_note": None,
    }
    base.update(kw)
    return base


def prep(cands, duration=120.0):
    return _prepare_rows(
        cands, duration=duration,
        word_starts=WORD_STARTS, word_ends=WORD_ENDS,
    )


def test_snap_moves_to_nearest_edge_within_window():
    assert _snap(10.4, WORD_STARTS) == 10.0
    assert _snap(24.0, WORD_STARTS) == 24.8
    # nothing within 3s → proposed time survives
    assert _snap(30.0, WORD_STARTS) == 30.0


def test_boundaries_snap_to_word_edges():
    rows = prep([cand(10.4, 25.0)])
    assert rows[0]["start_s"] == 10.0     # word start
    assert rows[0]["end_s"] == 25.7       # word end


def test_length_limits_enforced():
    assert prep([cand(10.0, 15.0)]) == []          # 5s < 12s min
    assert prep([cand(10.0, 90.0)]) == []          # 80s > 45s max
    assert len(prep([cand(10.0, 40.9)])) == 1      # 30.9s ok


def test_near_duplicates_collapse():
    rows = prep([cand(10.0, 40.9, score=0.9), cand(11.0, 40.0, score=0.5)])
    assert len(rows) == 1
    assert rows[0]["score"] == 0.9


def test_evidence_is_honest_content_line_with_no_n():
    rows = prep([cand(10.0, 40.9)])
    mt = rows[0]["matched_tags"]
    assert mt["basis"] == "content"
    assert mt["evidence"] == EVIDENCE_LINE
    assert "no performance data" in mt["evidence"]
    assert mt["n"] is None
    # decomposed for the future performance term
    assert mt["scores"] == {"content": 0.8}


def test_treatment_claim_flag_carries_reason():
    rows = prep([cand(10.0, 40.9, treatment_claim=True,
                      treatment_claim_note="clears acne")])
    mt = rows[0]["matched_tags"]
    assert mt["flag"] is True
    assert mt["flag_reason"] == "clears acne"
    unflagged = prep([cand(10.0, 40.9)])[0]["matched_tags"]
    assert unflagged["flag"] is False and unflagged["flag_reason"] is None


def test_sorted_by_score_and_capped():
    many = [cand(10.0, 40.0, score=0.1 * i) for i in range(1, 9)]
    # spread starts so dedupe doesn't collapse them
    for i, c in enumerate(many):
        c["start_s"] = 10.0 + i * 5
        c["end_s"] = c["start_s"] + 30
    rows = prep(many, duration=300.0)
    assert len(rows) == MAX_CANDIDATES
    scores = [r["score"] for r in rows]
    assert scores == sorted(scores, reverse=True)


def test_garbage_candidates_dropped_not_fatal():
    rows = prep([{"start_s": "nope", "end_s": None}, cand(10.0, 40.9)])
    assert len(rows) == 1


def test_clamped_to_video_bounds():
    rows = prep([cand(-2.0, 41.0)], duration=41.0)
    assert rows[0]["start_s"] >= 0.0
    assert rows[0]["end_s"] <= 41.0
