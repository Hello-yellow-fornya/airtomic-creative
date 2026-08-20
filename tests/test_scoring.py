"""Recency weighting and dated evidence lines."""

from datetime import date

from worker.scoring import (
    date_span, evidence_line, recency_weight, weighted_rate,
)

TODAY = date(2026, 8, 20)


def test_half_life_semantics():
    assert recency_weight(TODAY, TODAY, 365) == 1.0
    one_hl = recency_weight(date(2025, 8, 20), TODAY, 365)
    assert abs(one_hl - 0.5) < 0.01
    two_hl = recency_weight(date(2024, 8, 20), TODAY, 365)
    assert abs(two_hl - 0.25) < 0.01


def test_huge_half_life_approaches_flat():
    old = recency_weight(date(2023, 8, 20), TODAY, 1e9)
    assert old > 0.999


def test_undated_evidence_is_weak_not_zero():
    w = recency_weight(None, TODAY, 365)
    assert 0 < w < 0.2


def test_weighted_rate_prefers_recent_evidence():
    rows = [
        {"v3": 300, "imp": 1000, "date": TODAY},               # 30% now
        {"v3": 100, "imp": 1000, "date": date(2023, 8, 20)},   # 10%, 3 half-lives
    ]
    rate, eff = weighted_rate(rows, "v3", "imp", TODAY, 365)
    assert 0.25 < rate < 0.30            # pulled well toward the recent 30%
    unweighted = 400 / 2000
    assert rate > unweighted
    assert 1.0 < eff < 1.2               # old row contributes ~0.125 of a video


def test_weighted_rate_null_counts_excluded_not_zero():
    rows = [
        {"v3": None, "imp": 1000, "date": TODAY},   # null numerator: excluded
        {"v3": 200, "imp": 1000, "date": TODAY},
    ]
    rate, eff = weighted_rate(rows, "v3", "imp", TODAY, 365)
    assert rate == 0.2
    assert abs(eff - 1.0) < 1e-9


def test_weighted_rate_empty():
    assert weighted_rate([], "a", "b", TODAY) == (None, 0.0)


def test_evidence_line_carries_dates_and_weighting():
    line = evidence_line(
        14, date(2024, 3, 5), date(2026, 8, 1),
        stat="thumbstop 31% vs median 22%", half_life_days=365,
    )
    assert line == ("n=14 · thumbstop 31% vs median 22% · "
                    "evidence 2024-03 → 2026-08 · recency-weighted (half-life 12mo)")


def test_evidence_line_single_month_and_unknown():
    assert "evidence 2026-08 ·" in evidence_line(
        3, date(2026, 8, 1), date(2026, 8, 19), half_life_days=365)
    assert "evidence dates unknown" in evidence_line(3, None, None, half_life_days=365)


def test_date_span():
    assert date_span([None, date(2024, 1, 1), date(2026, 2, 2), None]) == \
        (date(2024, 1, 1), date(2026, 2, 2))
    assert date_span([None]) == (None, None)
