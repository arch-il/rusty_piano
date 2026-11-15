"""Graded timing score (0-100) from a note's onset offset, the same curve as the web page (coach/web/src/timing-score.ts).

The curve constants come from "timing" in coach/web/src/follower-settings.json; an attempt saves the ones it used in
settings.timing, so its scores can be recomputed the same way later. Old attempts have no timing_score and no
settings.timing: their score is computed from offset_ms with the default curve (old wait-mode steps have no offset
and so no score). The constants never change with the player's level, so scores stay comparable over time.
"""

import math
import statistics

DEFAULT_CURVE = {"perfect_ms": 20.0, "zero_ms": 250.0, "curve": 1.0}
DEFAULT_ON_TIME_MS = 80.0


def _num(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timing_score(offset_ms, curve: dict | None = None) -> int | None:
    if not _num(offset_ms):
        return None
    c = curve or DEFAULT_CURVE
    d = abs(offset_ms)
    if d <= c["perfect_ms"]:
        return 100
    if d >= c["zero_ms"]:
        return 0
    x = (d - c["perfect_ms"]) / (c["zero_ms"] - c["perfect_ms"])
    return math.floor(100 * (1 - x ** c["curve"]) + 0.5)


def outcome_of(offset_ms: float, on_time_ms: float = DEFAULT_ON_TIME_MS) -> str:
    if abs(offset_ms) <= on_time_ms:
        return "hit"
    return "early" if offset_ms < 0 else "late"


def curve_of(attempt: dict | None) -> dict:
    """The curve an attempt was scored with, or the default for attempts saved before the timing score."""
    settings = attempt.get("settings") if isinstance(attempt, dict) else None
    t = settings.get("timing") if isinstance(settings, dict) else None
    if isinstance(t, dict) and all(_num(t.get(k)) for k in DEFAULT_CURVE) and t["zero_ms"] > t["perfect_ms"] and t["curve"] > 0:
        return {k: float(t[k]) for k in DEFAULT_CURVE}
    return dict(DEFAULT_CURVE)


def step_timing_score(step: dict, curve: dict | None = None) -> int | None:
    if "timing_score" in step:
        value = step["timing_score"]
        return value if _num(value) else None
    if step.get("outcome") == "missed":
        return None
    return timing_score(step.get("offset_ms"), curve)


def step_outcome(step: dict, on_time_ms: float = DEFAULT_ON_TIME_MS, mode: str = "live") -> str | None:
    """The old hit / early / late / missed outcome: saved in the step, or derived from offset_ms in live mode."""
    if step.get("outcome") is not None:
        return step["outcome"]
    offset = step.get("offset_ms")
    if mode == "live" and _num(offset):
        return outcome_of(offset, on_time_ms)
    return None


def mean_score(scores) -> int | None:
    kept = [s for s in scores if s is not None]
    if not kept:
        return None
    return math.floor(statistics.fmean(kept) + 0.5)


def attempt_timing(attempt: dict) -> dict:
    """Mean timing score of an attempt's steps, overall and per bar (bar and pass as in the steps)."""
    curve = curve_of(attempt)
    steps = attempt.get("steps") or []
    scores = [step_timing_score(s, curve) for s in steps]
    bars: dict[tuple, list] = {}
    for s, score in zip(steps, scores):
        bars.setdefault((s.get("cycle"), s.get("bar"), s.get("pass")), []).append(score)
    return {
        "timing_score": mean_score(scores),
        "scored_steps": sum(1 for s in scores if s is not None),
        "curve": curve,
        "bars": [
            {"loop": k[0], "bar": k[1], "pass": k[2], "timing_score": mean_score(v)}
            for k, v in bars.items()
        ],
    }
