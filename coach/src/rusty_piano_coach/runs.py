"""Pure helpers that turn saved attempts into runs (one run per attempt, or per full loop cycle; a ramped loop takes its own tempo from practice.tempo.ramp) and judge them: clean-run check, per-bar stats and percentiles. Attempts where no step was ever judged (stopped before any note was due) are skipped as empty, and attempts are read through attempt_cache, which re-reads a file only when its size or modification time changes."""

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, tzinfo
from pathlib import Path

from . import attempt_cache
from . import attempts as attempts_mod
from . import evenness
from . import ear, sight
from . import timing

FUN_TAG = "fun"
CORRECT_RESULTS = ("hit", "early", "late", "short")
BAR_ERROR_RESULTS = ("wrong", "missed", "short")
HARD_BAR_MIN_RUNS = 3
HARD_BAR_ERROR_RATE = 0.3


@dataclass(frozen=True)
class Run:
    attempt_id: str
    cycle: int | None
    score_id: str
    title: str | None
    drill_id: str | None
    plan_id: str | None
    tags: tuple[str, ...]
    mode: str
    hands: str
    range: tuple[int, int] | None
    loop: bool
    tempo_percent: float
    started_at: datetime
    day: date
    end: str
    complete: bool
    counted: bool
    autoplay: bool
    steps: tuple[dict, ...]
    curve: dict


def attempt_counted(a) -> bool:
    _, _, tags = attempts_mod.attempt_drill(a)
    if FUN_TAG in tags:
        return False
    autoplay = a.get("autoplay")
    return not (isinstance(autoplay, dict) and bool(autoplay.get("used")))


def _aware_time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def load_attempts(attempts_dir) -> tuple[list[dict], list[str]]:
    found, skipped = attempt_cache.read_attempts(Path(attempts_dir))
    kept = []
    for a in found:
        score = a.get("score")
        try:
            if not isinstance(a.get("id"), str):
                raise ValueError("missing id")
            if not isinstance(score, dict) or not isinstance(score.get("id"), str):
                raise ValueError("missing score.id")
            if _aware_time(a.get("started_at")) is None:
                raise ValueError("started_at is not an aware time")
            if not isinstance(a.get("practice"), dict):
                raise ValueError("missing practice")
            if not isinstance(a.get("steps"), list):
                raise ValueError("missing steps")
        except ValueError as e:
            skipped.append(f"{a.get('id')}.json: not a complete attempt ({e})")
            continue
        if not any(isinstance(s, dict) and s.get("result") not in (None, "pending") for s in a["steps"]):
            skipped.append(f"{a['id']}.json: empty (stopped before any note was due)")
            continue
        kept.append(a)
    return kept, skipped


def runs_of_attempt(a, tz: tzinfo) -> list[Run]:
    practice = a["practice"]
    rng = practice.get("range")
    run_range = (rng["from"], rng["to"]) if isinstance(rng, dict) else None
    tempo = practice.get("tempo")
    percent = tempo.get("percent", 100) if isinstance(tempo, dict) else 100
    ramp = tempo.get("ramp") if isinstance(tempo, dict) else None
    cycles = ramp.get("cycles") if isinstance(ramp, dict) else None
    cycle_percent = {}
    for item in cycles if isinstance(cycles, list) else []:
        if not isinstance(item, dict):
            continue
        c, p = item.get("cycle"), item.get("percent")
        if isinstance(c, int) and not isinstance(c, bool) and isinstance(p, (int, float)) and not isinstance(p, bool):
            cycle_percent[c] = p
    started = _aware_time(a["started_at"])
    drill_id, plan_id, tags = attempts_mod.attempt_drill(a)
    autoplay = a.get("autoplay")

    def make(cycle, steps, complete, percent):
        return Run(
            attempt_id=a["id"],
            cycle=cycle,
            score_id=a["score"]["id"],
            title=a["score"].get("title"),
            drill_id=drill_id,
            plan_id=plan_id,
            tags=tags,
            mode=a.get("mode"),
            hands=practice.get("hands"),
            range=run_range,
            loop=bool(practice.get("loop")),
            tempo_percent=percent,
            started_at=started,
            day=started.astimezone(tz).date(),
            end=a.get("end"),
            complete=complete,
            counted=attempt_counted(a),
            autoplay=isinstance(autoplay, dict) and bool(autoplay.get("used")),
            steps=tuple(steps),
            curve=timing.curve_of(a),
        )

    steps = a["steps"]
    if not practice.get("loop"):
        return [make(None, steps, a.get("end") == "done", percent)]
    total = (a.get("plan") or {}).get("steps_total")
    by_cycle: dict = {}
    for s in steps:
        by_cycle.setdefault(s.get("cycle"), []).append(s)
    out = []
    for c in sorted(k for k in by_cycle if k is not None):
        group = by_cycle[c]
        if len(group) == total and not any(s.get("result") == "pending" for s in group):
            out.append(make(c, group, True, cycle_percent.get(c, percent)))
    return out or [make(None, steps, False, percent)]


def load_runs(attempts, tz: tzinfo) -> list[Run]:
    runs = []
    for a in attempts:
        runs.extend(runs_of_attempt(a, tz))
    return sorted(runs, key=lambda r: (r.started_at, r.cycle or 0))


_LOCAL = threading.local()


@contextmanager
def memoised():
    """Inside this block run_accuracy, run_timing, holds_kept, run_evenness_detail and bar_stats remember results per Run object (and bar_stats per exact list of runs). Callers must not mutate the returned values."""
    if getattr(_LOCAL, "memo", None) is not None:
        yield
        return
    _LOCAL.memo = {}
    try:
        yield
    finally:
        _LOCAL.memo = None


def _cached(kind, run, compute):
    memo = getattr(_LOCAL, "memo", None)
    if memo is None:
        return compute(run)
    key = (kind, id(run))
    hit = memo.get(key)
    if hit is None:
        hit = memo[key] = (run, compute(run))
    return hit[1]


def run_accuracy(run) -> float | None:
    return _cached("accuracy", run, _run_accuracy)


def run_timing(run) -> float | None:
    return _cached("timing", run, _run_timing)


def holds_kept(run) -> bool:
    return _cached("holds", run, _holds_kept)


def run_evenness_detail(run) -> dict | None:
    return _cached("evenness", run, _run_evenness_detail)


def bar_stats(runs) -> dict[int, dict]:
    runs = list(runs)
    memo = getattr(_LOCAL, "memo", None)
    if memo is None:
        return _bar_stats(runs)
    key = ("bars", tuple(id(r) for r in runs))
    hit = memo.get(key)
    if hit is None:
        hit = memo[key] = (tuple(runs), _bar_stats(runs))
    return hit[1]


def timing_ok(step) -> bool | None:
    # Descriptive only (on-time share, offset filtering); not used for clean runs or gates.
    # Wait-mode steps have no offset, so they give None.
    if step.get("offset_ms") is None or step.get("outcome") not in ("hit", "early", "late"):
        return None
    return step["outcome"] == "hit"


def _run_accuracy(run) -> float | None:
    total = 0
    correct = 0
    for s in run.steps:
        result = s.get("result")
        if result != "pending":
            total += 1
            if result in CORRECT_RESULTS:
                correct += 1
    if not total:
        return None
    return correct / total


def step_timing(step, curve=None) -> float | None:
    """The ONE place the clean-run and gate decisions read timing: the graded timing score as 0-1."""
    score = timing.step_timing_score(step, curve)
    return None if score is None else score / 100


def _run_timing(run) -> float | None:
    if run.mode != "live":
        return None
    values = [v for v in (step_timing(s, run.curve) for s in run.steps) if v is not None]
    if not values:
        return None
    return sum(values) / len(values)


def _holds_kept(run) -> bool:
    return not any(h.get("short") for s in run.steps for h in s.get("holds") or [])


def _run_evenness_detail(run) -> dict | None:
    if not evenness.is_scale_score(run.score_id):
        return None
    return evenness.compute(run.steps, score_id=run.score_id, hands=run.hands or "both")


def run_evenness(run) -> float | None:
    """The ONE place clean runs read evenness: the combined evenness as 0-1."""
    detail = run_evenness_detail(run)
    if detail is None or detail["combined"] is None:
        return None
    return detail["combined"] / 100


def is_clean(run, gate, drill=None, piece=False) -> bool:
    if not (run.counted and run.complete):
        return False
    accuracy = run_accuracy(run)
    if accuracy is None or accuracy < gate["accuracy"]:
        return False
    if sight.is_sight(run.score_id) and not sight.speed_ok(run.score_id, run.steps, gate):
        return False
    if ear.is_ear(run.score_id) and not ear.speed_ok(run.score_id, run.steps, gate):
        return False
    graded = run_timing(run)
    if graded is not None and graded < gate["timing"]:
        return False
    if gate.get("holds") and not holds_kept(run):
        return False
    if evenness.is_scale_score(run.score_id):
        even = run_evenness(run)
        if even is None or even < gate.get("evenness", evenness.DEFAULT_GATE):
            return False
    if drill:
        bars = drill.get("bars")
        want = (bars["from"], bars["to"]) if bars else None
        if run.hands != drill["hands"] or run.range != want:
            return False
        if drill["mode"] == "live":
            if run.mode != "live" or run.tempo_percent < gate["tempo_ratio"] * drill["tempo"]:
                return False
    if piece:
        if run.mode != "live" or run.hands != "both" or run.range is not None:
            return False
        if run.tempo_percent < gate["tempo_ratio"] * 100:
            return False
    return True


def _bar_stats(runs) -> dict[int, dict]:
    acc: dict = {}
    for run in runs:
        key = (run.attempt_id, run.cycle)
        touched = set()
        for s in run.steps:
            get = s.get
            result = get("result")
            if result == "pending":
                continue
            bar = get("bar")
            b = acc.get(bar)
            if b is None:
                b = acc[bar] = {"runs": set(), "steps": 0, "wrong": 0, "missed": 0, "short": 0, "offsets": []}
            if bar not in touched:
                touched.add(bar)
                b["runs"].add(key)
            b["steps"] += 1
            if result in ("wrong", "missed", "short"):
                b[result] += 1
            offset = get("offset_ms")
            if offset is not None:
                b["offsets"].append(offset)
    out = {}
    for bar, b in acc.items():
        errors = b["wrong"] + b["missed"] + b["short"]
        offsets = b["offsets"]
        out[bar] = {
            "runs": len(b["runs"]),
            "steps": b["steps"],
            "errors": errors,
            "error_rate": round(errors / b["steps"], 3),
            "wrong": b["wrong"],
            "missed": b["missed"],
            "short": b["short"],
            "mean_offset_ms": round(sum(offsets) / len(offsets), 1) if offsets else None,
        }
    return out


def hard_bars(stats) -> list[int]:
    return sorted(
        bar
        for bar, s in stats.items()
        if s["runs"] >= HARD_BAR_MIN_RUNS and s["error_rate"] >= HARD_BAR_ERROR_RATE
    )


def percentile(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[int(q * (len(ordered) - 1) + 0.5)]


def engine_velocities(a) -> list[int]:
    if "events" not in a and isinstance(a.get("_engine_velocities"), list):
        return list(a["_engine_velocities"])
    return [
        e["velocity"]
        for e in a.get("events") or []
        if e.get("type") == "note_on" and e.get("source") == "engine" and e.get("velocity") is not None
    ]
