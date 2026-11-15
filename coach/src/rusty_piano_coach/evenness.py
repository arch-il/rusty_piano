"""Rhythmic evenness (0-100) of runs on scale scores (ids starting scales:): how equal the gaps between consecutive notes are, ignoring the beat; per hand, combined and hands-together alignment. Same algorithm and constants as coach/web/src/evenness.ts; the shared fixture coach/web/tests/fixtures/evenness-cases.json proves they match. Old attempts without a saved evenness are computed from their steps.
"""

import math
from collections import Counter

SCALES_PREFIX = "scales:"
DEFAULT_GATE = 0.8
CONSTANTS = {
    "perfect_cv": 0.03,
    "zero_cv": 0.25,
    "align_perfect_ms": 15,
    "align_zero_ms": 120,
    "weak_min_dev": 0.15,
    "min_intervals": 4,
    "max_weak_spots": 5,
}


def is_scale_score(score_id) -> bool:
    return isinstance(score_id, str) and score_id.startswith(SCALES_PREFIX)


def round_half_up(x) -> int:
    return math.floor(x + 0.5)


def _r3(x):
    return math.floor(x * 1000 + 0.5) / 1000


def _r1(x):
    return math.floor(x * 10 + 0.5) / 10


def _num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _or(value, default):
    return value if _num(value) else default


def evenness_score(cv: float) -> int:
    c = CONSTANTS
    if cv <= c["perfect_cv"]:
        return 100
    if cv >= c["zero_cv"]:
        return 0
    return round_half_up(100 * (1 - (cv - c["perfect_cv"]) / (c["zero_cv"] - c["perfect_cv"])))


def alignment_score(diff_ms: float) -> int:
    c = CONSTANTS
    if diff_ms <= c["align_perfect_ms"]:
        return 100
    if diff_ms >= c["align_zero_ms"]:
        return 0
    return round_half_up(100 * (1 - (diff_ms - c["align_perfect_ms"]) / (c["align_zero_ms"] - c["align_perfect_ms"])))


def _read(s: dict) -> dict:
    return {
        "cycle": _or(s.get("cycle"), 0),
        "step": _or(s.get("step"), 0),
        "source_step": _or(s.get("source_step"), 0),
        "bar": _or(s.get("bar"), 0),
        "time_q": _or(s.get("time_q"), 0.0),
        "expected": [v for v in (s.get("expected") or []) if _num(v)],
        "played": [p for p in (s.get("played") or []) if isinstance(p, dict)],
    }


def _hand_map(expected, default_hand) -> dict:
    if len(expected) >= 2:
        return {"left": min(expected), "right": max(expected)}
    if len(expected) == 1:
        return {default_hand: expected[0]}
    return {}


def _onset(step, hand):
    pitch = step["map"].get(hand)
    if pitch is None:
        return None
    times = [p["page_ms"] for p in step["played"] if _num(p.get("page_ms")) and p.get("note") == pitch]
    return min(times) if times else None


def compute(steps, *, score_id: str, hands) -> dict:
    if hands == "left":
        default_hand = "left"
    elif hands == "right":
        default_hand = "right"
    else:
        default_hand = "left" if score_id.endswith("-lh") else "right"
    ordered = sorted((_read(s) for s in steps), key=lambda s: (s["cycle"], s["step"]))
    for s in ordered:
        s["map"] = _hand_map(s["expected"], default_hand)
    present = [h for h in ("right", "left") if any(h in s["map"] for s in ordered)]

    result = {"right": None, "left": None}
    candidates = []
    for h in present:
        pairs = []
        for a, b in zip(ordered, ordered[1:]):
            if a["cycle"] != b["cycle"] or b["step"] != a["step"] + 1:
                continue
            oa, ob = _onset(a, h), _onset(b, h)
            if oa is None or ob is None:
                continue
            gap = math.floor((b["time_q"] - a["time_q"]) * 1e6 + 0.5) / 1e6
            pairs.append((a, b, gap, ob - oa))
        counts = Counter(p[2] for p in pairs)
        main = max(counts, key=lambda g: (counts[g], -g)) if counts else None
        kept = [p for p in pairs if p[2] == main and p[3] > 0]
        n = len(kept)
        if n < CONSTANTS["min_intervals"]:
            result[h] = {"score": None, "cv": None, "intervals": n, "mean_ms": None}
            continue
        total = 0.0
        for p in kept:
            total += p[3]
        mean = total / n
        squares = 0.0
        for p in kept:
            squares += (p[3] - mean) * (p[3] - mean)
        cv = math.sqrt(squares / n) / mean
        result[h] = {"score": evenness_score(cv), "cv": _r3(cv), "intervals": n, "mean_ms": _r1(mean)}
        for a, b, gap, ioi in kept:
            dev = (ioi - mean) / mean
            if abs(dev) >= CONSTANTS["weak_min_dev"]:
                spot = {
                    "hand": h,
                    "cycle": b["cycle"],
                    "step": b["step"],
                    "source_step": b["source_step"],
                    "bar": b["bar"],
                    "deviation": _r3(dev),
                    "gap_ms": _r1(ioi),
                }
                candidates.append((-abs(dev), b["cycle"], b["step"], 0 if h == "right" else 1, spot))
    candidates.sort(key=lambda c: c[:4])
    weak_spots = [c[4] for c in candidates[: CONSTANTS["max_weak_spots"]]]

    scores = [result[h]["score"] for h in ("right", "left") if result[h] and result[h]["score"] is not None]
    combined = None
    if scores:
        total = 0
        for v in scores:
            total += v
        combined = round_half_up(total / len(scores))

    alignment = None
    if "right" in present and "left" in present:
        diffs = []
        for s in ordered:
            r, l = _onset(s, "right"), _onset(s, "left")
            if r is not None and l is not None:
                diffs.append(abs(r - l))
        alignment = {"score": None, "mean_ms": None, "steps": len(diffs)}
        if diffs:
            scored = 0
            total = 0.0
            for d in diffs:
                scored += alignment_score(d)
                total += d
            alignment["score"] = round_half_up(scored / len(diffs))
            alignment["mean_ms"] = _r1(total / len(diffs))

    return {
        "version": 1,
        "constants": dict(CONSTANTS),
        "right": result["right"],
        "left": result["left"],
        "combined": combined,
        "alignment": alignment,
        "weak_spots": weak_spots,
    }


def attempt_evenness(attempt: dict) -> dict | None:
    score_id = (attempt.get("score") or {}).get("id")
    if not is_scale_score(score_id):
        return None
    saved = attempt.get("evenness")
    if isinstance(saved, dict) and "combined" in saved:
        return saved
    hands = (attempt.get("practice") or {}).get("hands") or "both"
    return compute(attempt.get("steps") or [], score_id=score_id, hands=hands)
