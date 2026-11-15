import json
from pathlib import Path

OFFSETS = {"hit": 0.0, "early": -100.0, "late": 100.0}


def make_steps(results, *, cycle=1, bar_of=None, offsets=None, expected=60):
    steps = []
    for i, result in enumerate(results):
        step = {
            "cycle": cycle,
            "step": i,
            "source_step": i,
            "bar": bar_of(i) if bar_of else i // 4 + 1,
            "beat": i % 4,
            "pass": 1,
            "time_q": float(i),
            "expected": [expected],
            "result": result,
            "outcome": None,
            "offset_ms": None,
            "played": [],
            "wrong": [],
            "holds": [],
        }
        if result in ("hit", "early", "late"):
            off = offsets[i] if offsets else OFFSETS[result]
            step["outcome"] = result
            step["offset_ms"] = off
            step["played"] = [{"note": expected, "offset_ms": off, "page_ms": 0}]
        elif result == "missed":
            step["outcome"] = "missed"
        elif result == "wrong":
            step["outcome"] = "hit"
            step["offset_ms"] = 0.0
            step["wrong"] = [{"note": expected + 1, "page_ms": 0}]
        elif result == "short":
            step["outcome"] = "hit"
            step["offset_ms"] = 0.0
            step["holds"] = [
                {"note": expected, "held_ms": 100, "expected_ms": 1000, "short": True, "page_ms": 0}
            ]
        steps.append(step)
    return steps


def scored_steps(scores, *, result="hit", outcome=None, offset=0.0):
    steps = make_steps([result] * len(scores))
    for s, score in zip(steps, scores):
        s["timing_score"] = score
        s["offset_ms"] = offset
        if outcome:
            s["outcome"] = outcome
    return steps


def wait_steps(n):
    steps = make_steps(["hit"] * n)
    for s in steps:
        s["offset_ms"] = None
        for p in s["played"]:
            p["offset_ms"] = None
    return steps


def make_attempt(**kw):
    steps = kw.get("steps")
    if steps is None:
        steps = make_steps(["hit"] * 16)
    attempt = {
        "version": 2,
        "id": kw.get("id", "attempt-20261101-100000-aaaaaa"),
        "saved_at": "2026-11-01T10:01:00Z",
        "kind": "rusty_piano.attempt",
        "score": {"id": kw.get("score", "gen:t1-quarters-rh"), "title": kw.get("title", "Quarters")},
        "mode": kw.get("mode", "live"),
        "end": kw.get("end", "done"),
        "started_at": kw.get("started_at", "2026-11-01T10:00:00+00:00"),
        "duration_ms": kw.get("duration_ms", 60000),
        "practice": {
            "hands": kw.get("hands", "right"),
            "range": kw.get("range"),
            "loop": kw.get("loop", False),
            "loops_completed": kw.get("loops_completed", 0),
            "tempo": {"percent": kw.get("tempo_percent", 100)},
        },
        "plan": {
            "steps_total": kw.get("steps_total", len(steps)),
            "first_bar": kw.get("first_bar", 1),
            "last_bar": kw.get("last_bar", 4),
        },
        "autoplay": {"used": kw.get("autoplay_used", False)},
        "steps": steps,
        "events": kw.get("events", []),
        "summary": {"counts": {}},
        "sources": ["engine"],
        "drill_id": kw.get("drill_id"),
        "plan_id": kw.get("plan_id"),
        "tags": kw.get("tags", []),
    }
    return attempt


def note_on(velocity, t=0):
    return {"type": "note_on", "source": "engine", "note": 60, "velocity": velocity, "t": t, "page_ms": t}


def write_attempts(folder, attempts):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    for a in attempts:
        (folder / f"{a['id']}.json").write_text(json.dumps(a), encoding="utf-8")


def make_report(
    *,
    attempt_id=None,
    score_id="gen:t1-quarters-rh",
    created_at="2026-11-01T10:05:00Z",
    session_started_at=None,
    notes=(),
    bars=(),
    drift=None,
):
    return {
        "version": 1,
        "kind": "rusty_piano.report",
        "created_at": created_at,
        "input": {"kind": "attempt", "attempt_id": attempt_id, "session_started_at": session_started_at},
        "score": {"id": score_id},
        "summary": {"drift_bpm_per_bar": drift},
        "notes": list(notes),
        "bars": list(bars),
    }


def write_reports(folder, reports):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    for i, r in enumerate(reports):
        (folder / f"report-{i}.json").write_text(json.dumps(r), encoding="utf-8")


def tiny_tree():
    def drill(did, score, hands, mode):
        return {
            "id": did,
            "kind": "generated",
            "title": did,
            "score": score,
            "hands": hands,
            "mode": mode,
            "tempo": 100,
            "loop": False,
            "bars": None,
            "goal": "goal",
        }

    def node(nid, track, title, drills, requires=()):
        return {
            "id": nid,
            "kind": "skill",
            "track": track,
            "title": title,
            "summary": title,
            "requires": list(requires),
            "measures": ["pitch"],
            "drills": drills,
        }

    return {
        "version": 1,
        "kind": "rusty_piano.tree",
        "decay_days": 30,
        "default_gates": {
            "good": {"accuracy": 0.95, "timing": 0.6, "tempo_ratio": 0.8, "clean_runs": 3, "days": 2, "holds": True},
            "solid": {
                "accuracy": 0.98,
                "timing": 0.8,
                "tempo_ratio": 1.0,
                "window": 7,
                "clean_in_window": 5,
                "days": 3,
                "habit_free": True,
                "holds": True,
            },
            "mastered": {
                "accuracy": 0.98,
                "timing": 0.8,
                "tempo_ratio": 1.0,
                "away_days": 7,
                "cold_runs": 3,
                "materials": 2,
                "holds": True,
            },
        },
        "tracks": [{"id": "rhythm", "title": "Rhythm"}, {"id": "reading", "title": "Reading"}],
        "nodes": [
            node("T1", "rhythm", "Quarters", [drill("t1.q", "gen:t1-quarters-rh", "right", "live")]),
            node("T2", "rhythm", "Halves", [drill("t2.h", "gen:t2-halves-rh", "right", "live")], ["T1"]),
            node("R1", "reading", "Cs", [drill("r1.c", "gen:r1-all-cs", "both", "wait")]),
        ],
    }
