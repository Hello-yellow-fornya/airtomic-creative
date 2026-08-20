"""Corpus weighting and evidence lines for the recommendation scorer.

Recency is ONE tunable weight: an exponential half-life over the age of
the evidence, applied AT SCORING TIME to raw counts — never persisted
(CLAUDE.md §2: store numerators and denominators, compute at read).
RECENCY_HALF_LIFE_DAYS is the single knob (env-tunable, default 365):
a creative from one half-life ago counts half as much as one from today;
setting it very large approaches no recency preference. There is no hard
date cutoff — old evidence fades, it doesn't vanish.

Every surfaced pattern must carry its sample size AND its dates: a
pattern seen only in 2024 creative is a different claim from one seen
last month, and the evidence line says which. evidence_line() is the one
formatter both the Find cutboxes and the 03 cards render, so the wording
can't drift between screens.
"""

import math
import os
from datetime import date

RECENCY_HALF_LIFE_DAYS = float(os.environ.get("RECENCY_HALF_LIFE_DAYS", "365"))


def recency_weight(evidence_date: date | None, today: date,
                   half_life_days: float | None = None) -> float:
    """0..1 exponential decay by age. Undated evidence gets the weight of
    the oldest plausible age we track (~3 years) rather than 0 — undated
    is weak evidence, not no evidence."""
    hl = half_life_days if half_life_days is not None else RECENCY_HALF_LIFE_DAYS
    if hl <= 0:
        return 1.0
    age_days = (today - evidence_date).days if evidence_date else 3 * 365
    return 0.5 ** (max(0.0, age_days) / hl)


def weighted_rate(rows: list[dict], num_key: str, den_key: str, today: date,
                  half_life_days: float | None = None) -> tuple[float | None, float]:
    """Recency-weighted rate over per-video raw counts.

    rows: [{num_key: int|None, den_key: int|None, "date": date|None}, ...]
    Returns (rate, effective_n) — rate is sum(w*num)/sum(w*den) computed
    here at read time, and effective_n is the weight-sum (how much
    evidence the rate really rests on; 10 stale videos may be worth 3).
    Rows missing either count are excluded — null is not zero."""
    wn = wd = eff = 0.0
    for r in rows:
        num, den = r.get(num_key), r.get(den_key)
        if num is None or den is None or den == 0:
            continue
        w = recency_weight(r.get("date"), today, half_life_days)
        wn += w * float(num)
        wd += w * float(den)
        eff += w
    if wd == 0:
        return None, 0.0
    return wn / wd, eff


def date_span(dates: list[date | None]) -> tuple[date | None, date | None]:
    real = [d for d in dates if d is not None]
    return (min(real), max(real)) if real else (None, None)


def evidence_line(n: int, first: date | None, last: date | None,
                  stat: str | None = None,
                  half_life_days: float | None = None) -> str:
    """The dated evidence line for a performance-backed pattern, e.g.
    'n=14 · thumbstop 31% vs median 22% · evidence 2024-03 → 2026-08 ·
    recency-weighted (half-life 12mo)'. n and dates are facts about the
    corpus, never invented — callers with no performance data must keep
    using the content-basis line, not this."""
    hl = half_life_days if half_life_days is not None else RECENCY_HALF_LIFE_DAYS
    parts = [f"n={n}"]
    if stat:
        parts.append(stat)
    if first and last:
        f, l = first.strftime("%Y-%m"), last.strftime("%Y-%m")
        parts.append(f"evidence {f} → {l}" if f != l else f"evidence {f}")
    else:
        parts.append("evidence dates unknown")
    months = hl / 30.44
    parts.append(f"recency-weighted (half-life {months:.0f}mo)")
    return " · ".join(parts)
