"""Ear-training rounds (score ids ear:<level>): per-kind speed targets for clean runs, drill stats for coach evidence and a compact round history for the page."""

import statistics
from pathlib import Path

from . import attempt_cache
from .sight import _parse_started, _valid_ms, gate_level

SCORE_PREFIX = "ear:"
EAR_TAG = "ear-training"
HISTORY_LIMIT = 200
LEVEL_RE = r"[a-z0-9-]{1,30}"
LEVEL_KINDS = {
    **{k: "note" for k in ("echo-1", "echo-2", "echo-3", "updown-1", "updown-2", "interval-1", "interval-2", "interval-3", "interval-4")},
    **{k: "chord" for k in ("chord-1", "chord-2", "chord-3", "chord-4")},
    **{k: "phrase" for k in ("echo-4", "echo-5", "tune-1", "tune-2", "tune-3", "bass-1", "bass-2", "bass-3", "bass-4")},
}
TARGETS_MS = {
    "note": {"good": 5000, "solid": 3000, "mastered": 2000},
    "chord": {"good": 8000, "solid": 5000, "mastered": 3500},
    "phrase": {"good": 2500, "solid": 1800, "mastered": 1200},
}


def is_ear(score_id) -> bool:
    return isinstance(score_id, str) and score_id.startswith(SCORE_PREFIX)


def level_of(score_id) -> str | None:
    if not is_ear(score_id):
        return None
    return score_id[len(SCORE_PREFIX):]


def _count(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def step_ms(step) -> float | None:
    if not isinstance(step, dict) or step.get("result") == "pending" or not _valid_ms(step.get("response_ms")):
        return None
    steps = step.get("answer_steps")
    divisor = steps if isinstance(steps, int) and not isinstance(steps, bool) and steps > 0 else 1
    return step["response_ms"] / max(1, divisor)


def median_step_ms(steps) -> float | None:
    values = [v for v in (step_ms(s) for s in steps) if v is not None]
    return float(statistics.median(values)) if values else None


def speed_ok(score_id, steps, gate) -> bool:
    kind = LEVEL_KINDS.get(level_of(score_id), "note")
    target = TARGETS_MS[kind][gate_level(gate)]
    med = median_step_ms(steps)
    return med is not None and med <= target


def _answered(runs):
    return [s for r in runs for s in r.steps if isinstance(s, dict) and s.get("result") != "pending"]


def drill_stats(runs) -> dict:
    steps = _answered(runs)
    n = len(steps)
    first = sum(1 for s in steps if s.get("first_try") is True)
    replays = sum(_count(s.get("replays")) for s in steps)
    categories: dict = {}
    for s in steps:
        c = categories.setdefault(s.get("category") or "?", {"items": 0, "first_try": 0})
        c["items"] += 1
        if s.get("first_try") is True:
            c["first_try"] += 1
    med = median_step_ms(steps)
    return {
        "rounds": len(runs),
        "items": n,
        "first_try_share": round(first / n, 3) if n else None,
        "replays_per_item": round(replays / n, 2) if n else None,
        "revealed": sum(1 for s in steps if s.get("revealed") is True),
        "median_step_ms": round(med, 1) if med is not None else None,
        "categories": categories,
    }


def _compact_item(step) -> dict:
    return {
        "category": step.get("category"),
        "first_try": step.get("first_try") is True,
        "response_ms": step["response_ms"] if _valid_ms(step.get("response_ms")) else None,
        "answer_steps": _count(step.get("answer_steps")) or 1,
        "replays": _count(step.get("replays")),
        "revealed": step.get("revealed") is True,
    }


def _round(attempt) -> dict:
    raw = [s for s in attempt.get("steps") or [] if isinstance(s, dict)]
    items = [_compact_item(s) for s in raw]
    accuracy = round(sum(1 for i in items if i["first_try"]) / len(items), 3) if items else None
    return {
        "id": attempt.get("id"),
        "started_at": attempt["started_at"],
        "level": level_of(attempt["score"]["id"]),
        "drill_id": attempt.get("drill_id"),
        "end": attempt.get("end"),
        "accuracy": accuracy,
        "median_step_ms": median_step_ms(raw),
        "replays": sum(i["replays"] for i in items),
        "items": items,
    }


def history(attempts_dir, level=None, limit=HISTORY_LIMIT) -> dict:
    found, _ = attempt_cache.read_attempts(Path(attempts_dir))
    rows = []
    for a in found:
        score = a.get("score")
        if not isinstance(score, dict) or not is_ear(score.get("id")):
            continue
        if level is not None and level_of(score["id"]) != level:
            continue
        started = _parse_started(a.get("started_at"))
        if started is None:
            continue
        rows.append((started, str(a.get("id", "")), a))
    rows.sort(key=lambda r: (r[0], r[1]))
    rounds = [_round(a) for _, _, a in rows]
    return {"rounds": rounds[max(0, len(rounds) - limit):]}
