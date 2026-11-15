"""Sight-reading drill rounds (score ids sight:<level>): per-level speed targets for clean runs and a compact round history for the page."""

import math
import statistics
from datetime import datetime
from pathlib import Path

from . import attempt_cache

SCORE_PREFIX = "sight:"
SIGHT_TAG = "sight-reading"
HISTORY_LIMIT = 200
LEVEL_RE = r"[a-z0-9-]{1,30}"
LEVEL_KINDS = {
    "r2-treble": "notes",
    "r3-bass": "notes",
    "r4-grand": "notes",
    "r5-intervals": "intervals",
    "r6-ledger": "notes",
    "r7-keys": "notes",
    "r8a-five": "bars",
    "r8b-wide": "bars",
    "r8c-hands": "bars",
    "custom": "notes",
}
TARGETS_MS = {
    "notes": {"good": 2000, "solid": 1200, "mastered": 800},
    "intervals": {"good": 3000, "solid": 2000, "mastered": 1400},
    "bars": {"good": 1500, "solid": 1000, "mastered": 700},
}


def is_sight(score_id) -> bool:
    return isinstance(score_id, str) and score_id.startswith(SCORE_PREFIX)


def level_of(score_id) -> str | None:
    if not is_sight(score_id):
        return None
    return score_id[len(SCORE_PREFIX):]


def gate_level(gate: dict) -> str:
    if "away_days" in gate:
        return "mastered"
    if "window" in gate:
        return "solid"
    return "good"


def _valid_ms(value) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def median_reaction_ms(steps) -> float | None:
    values = [
        s["reaction_ms"]
        for s in steps
        if isinstance(s, dict) and s.get("result") != "pending" and _valid_ms(s.get("reaction_ms"))
    ]
    return float(statistics.median(values)) if values else None


def speed_ok(score_id, steps, gate) -> bool:
    kind = LEVEL_KINDS.get(level_of(score_id), "notes")
    target = TARGETS_MS[kind][gate_level(gate)]
    med = median_reaction_ms(steps)
    return med is not None and med <= target


def _parse_started(value):
    if not isinstance(value, str):
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _compact_step(step) -> dict:
    notes = [n for n in step["notes"] if isinstance(n, int) and not isinstance(n, bool)]
    wrong = step.get("wrong_count")
    return {
        "notes": notes,
        "first_try": step.get("first_try") is True,
        "reaction_ms": step["reaction_ms"] if _valid_ms(step.get("reaction_ms")) else None,
        "hinted": step.get("hinted") is True,
        "wrong_count": wrong if isinstance(wrong, int) and not isinstance(wrong, bool) else 0,
    }


def _round(attempt) -> dict:
    raw = [s for s in attempt.get("steps") or [] if isinstance(s, dict) and isinstance(s.get("notes"), list)]
    steps = [_compact_step(s) for s in raw]
    accuracy = round(sum(1 for s in steps if s["first_try"]) / len(steps), 3) if steps else None
    return {
        "id": attempt.get("id"),
        "started_at": attempt["started_at"],
        "level": level_of(attempt["score"]["id"]),
        "drill_id": attempt.get("drill_id"),
        "end": attempt.get("end"),
        "accuracy": accuracy,
        "median_ms": median_reaction_ms(raw),
        "steps": steps,
    }


def history(attempts_dir, level=None, limit=HISTORY_LIMIT) -> dict:
    found, _ = attempt_cache.read_attempts(Path(attempts_dir))
    rows = []
    for a in found:
        score = a.get("score")
        if not isinstance(score, dict) or not is_sight(score.get("id")):
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
