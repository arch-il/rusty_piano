import json
from datetime import date, datetime, timezone

from evidence_fixtures import make_attempt, tiny_tree, write_attempts

from rusty_piano_coach import ear, runs, trends

UTC = timezone.utc
NOW = datetime(2026, 11, 5, 12, 0, tzinfo=UTC)
GOOD = {"accuracy": 0.9}
SOLID = {"accuracy": 0.95, "window": 7}
MASTERED = {"accuracy": 0.95, "away_days": 7}


def ear_attempt(id, started_at, results=None, responses=None, replays=None, end="done", level="echo-1", answer_steps=None):
    results = results if results is not None else ["hit"] * 10
    steps = []
    for i, result in enumerate(results):
        step = {
            "step": i,
            "item": i,
            "type": "note",
            "category": "low" if i % 2 == 0 else "high",
            "label": f"item {i}",
            "prompt_notes": [60],
            "given": [60],
            "answer_notes": [60],
            "answer_steps": answer_steps[i] if answer_steps else 1,
            "result": result,
            "first_try": result == "hit",
            "wrong_count": 0 if result == "hit" else 1,
            "wrong_notes": [],
            "replays": replays[i] if replays else 0,
            "revealed": False,
            "response_ms": responses[i] if responses else 1000.0,
            "asked_page_ms": 0,
            "done_page_ms": 0,
        }
        steps.append({k: v for k, v in step.items() if v is not None and v != []})
    attempt = make_attempt(
        id=id,
        score=f"ear:{level}",
        title="Ear",
        mode="wait",
        end=end,
        started_at=started_at,
        hands="both",
        steps=steps,
        drill_id=f"ear.{level}",
        tags=["ear-training"],
    )
    return attempt


def one_run(**kw):
    return runs.runs_of_attempt(ear_attempt("attempt-20261101-100000-eeeeee", "2026-11-01T10:00:00+00:00", **kw), UTC)[0]


def test_is_ear_and_level():
    assert ear.is_ear("ear:echo-1")
    assert not ear.is_ear("sight:r2-treble")
    assert not ear.is_ear(None)
    assert ear.level_of("ear:chord-2") == "chord-2"
    assert ear.level_of("gen:x") is None


def test_step_ms_and_median():
    assert ear.step_ms({"result": "hit", "response_ms": 3000.0, "answer_steps": 3}) == 1000.0
    assert ear.step_ms({"result": "hit", "response_ms": 900.0}) == 900.0
    assert ear.step_ms({"result": "hit", "response_ms": 900.0, "answer_steps": "x"}) == 900.0
    assert ear.step_ms({"result": "pending", "response_ms": 900.0}) is None
    assert ear.step_ms({"result": "hit"}) is None
    assert ear.step_ms({"result": "hit", "response_ms": True}) is None
    steps = [
        {"result": "hit", "response_ms": 1000.0},
        {"result": "hit", "response_ms": 6000.0, "answer_steps": 2},
        {"result": "hit", "response_ms": 5000.0},
        {"result": "pending", "response_ms": 9.0},
        {"result": "hit"},
    ]
    assert ear.median_step_ms(steps) == 3000.0
    assert ear.median_step_ms([{"result": "hit"}]) is None


def test_speed_ok_by_kind_and_gate():
    def steps(ms):
        return [{"result": "hit", "response_ms": ms}]

    assert ear.speed_ok("ear:echo-1", steps(5000), GOOD)
    assert not ear.speed_ok("ear:echo-1", steps(5001), GOOD)
    assert ear.speed_ok("ear:echo-1", steps(3000), SOLID)
    assert not ear.speed_ok("ear:echo-1", steps(3001), SOLID)
    assert not ear.speed_ok("ear:echo-1", steps(2001), MASTERED)
    assert ear.speed_ok("ear:chord-1", steps(8000), GOOD)
    assert not ear.speed_ok("ear:chord-1", steps(3501), MASTERED)
    assert ear.speed_ok("ear:tune-1", steps(2500), GOOD)
    assert not ear.speed_ok("ear:tune-1", steps(2501), GOOD)
    assert ear.speed_ok("ear:unknown", steps(5000), GOOD)
    assert not ear.speed_ok("ear:echo-1", [], GOOD)


def test_is_clean_ear_run():
    gate = {"accuracy": 0.9}
    assert runs.is_clean(one_run(results=["hit"] * 9 + ["wrong"]), gate)
    assert not runs.is_clean(one_run(results=["hit"] * 8 + ["wrong"] * 2), gate)
    assert not runs.is_clean(one_run(responses=[6000.0] * 10), gate)
    assert not runs.is_clean(one_run(end="stop"), gate)


def evidence_tree():
    tree = tiny_tree()
    tree["tracks"].append({"id": "ear", "title": "Ear training"})
    tree["nodes"].append(
        {
            "id": "E1",
            "kind": "skill",
            "track": "ear",
            "title": "Echo",
            "summary": "Echo",
            "requires": [],
            "measures": ["pitch"],
            "gates": {
                "good": {"accuracy": 0.9},
                "solid": {"accuracy": 0.95},
                "mastered": {"accuracy": 0.95},
            },
            "drills": [
                {
                    "id": "ear.echo-1",
                    "kind": "generated",
                    "title": "Echo 1",
                    "score": "ear:echo-1",
                    "hands": "both",
                    "mode": "wait",
                    "tempo": 100,
                    "loop": False,
                    "bars": None,
                    "goal": "goal",
                }
            ],
        }
    )
    return tree


def build(tmp_path, attempt_list):
    ad, rd, pd, sd = (tmp_path / n for n in ("attempts", "reports", "plan", "scores"))
    pd.mkdir()
    (pd / "tree.json").write_text(json.dumps(evidence_tree()), encoding="utf-8")
    write_attempts(ad, attempt_list)
    return trends.build_evidence(
        attempts_dir=ad,
        reports_dir=rd,
        plan_dir=pd,
        scores_dir=sd,
        since=None,
        today=date(2026, 11, 5),
        tz=UTC,
        now=NOW,
    )


def test_evidence_ear_drill(tmp_path):
    atts = [
        ear_attempt("attempt-20261101-100000-aaaaa1", "2026-11-01T10:00:00+00:00", results=["hit"] * 9 + ["wrong"], replays=[1] + [0] * 9),
        ear_attempt("attempt-20261101-110000-aaaaa2", "2026-11-01T11:00:00+00:00"),
        ear_attempt("attempt-20261102-100000-aaaaa3", "2026-11-02T10:00:00+00:00"),
    ]
    ev = build(tmp_path, atts)
    entry = ev["drills"]["ear.echo-1"]
    assert entry["clean_good"] == 3
    assert entry["days"] == 2
    assert entry["ear"] == {
        "rounds": 3,
        "items": 30,
        "first_try_share": 0.967,
        "replays_per_item": 0.03,
        "revealed": 0,
        "median_step_ms": 1000.0,
        "categories": {"low": {"items": 15, "first_try": 15}, "high": {"items": 15, "first_try": 14}},
    }
    assert ev["pending_analysis"] == []
    assert "ear:echo-1" not in ev["pieces"]


def test_non_ear_drill_has_no_ear_key(tmp_path):
    other = make_attempt(id="attempt-20261101-100000-bbbbb1", drill_id="t1.q")
    ev = build(tmp_path, [other, ear_attempt("attempt-20261101-110000-aaaaa2", "2026-11-01T11:00:00+00:00")])
    assert "ear" not in ev["drills"]["t1.q"]
    assert "ear" in ev["drills"]["ear.echo-1"]


def test_history_shape_and_level_filter(tmp_path):
    ad = tmp_path / "attempts"
    write_attempts(
        ad,
        [
            ear_attempt("attempt-20261102-100000-aaaaa3", "2026-11-02T10:00:00+00:00", level="chord-1", responses=[2000.0] * 10),
            ear_attempt("attempt-20261101-100000-aaaaa1", "2026-11-01T10:00:00+00:00", results=["hit"] * 9 + ["wrong"], replays=[2] + [0] * 9),
            make_attempt(id="attempt-20261101-120000-bbbbb1"),
        ],
    )
    rounds = ear.history(ad)["rounds"]
    assert [r["id"] for r in rounds] == ["attempt-20261101-100000-aaaaa1", "attempt-20261102-100000-aaaaa3"]
    first = rounds[0]
    assert first["level"] == "echo-1"
    assert first["drill_id"] == "ear.echo-1"
    assert first["end"] == "done"
    assert first["accuracy"] == 0.9
    assert first["median_step_ms"] == 1000.0
    assert first["replays"] == 2
    assert len(first["items"]) == 10
    assert first["items"][0] == {
        "category": "low",
        "first_try": True,
        "response_ms": 1000.0,
        "answer_steps": 1,
        "replays": 2,
        "revealed": False,
    }
    only = ear.history(ad, level="chord-1")["rounds"]
    assert [r["level"] for r in only] == ["chord-1"]
    assert len(ear.history(ad, limit=1)["rounds"]) == 1
