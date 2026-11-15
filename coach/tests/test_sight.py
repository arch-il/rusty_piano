from datetime import date, datetime, timezone

from evidence_fixtures import tiny_tree

from rusty_piano_coach import attempts, habits, runs, sight, trends

UTC = timezone.utc
GATE_GOOD = {"accuracy": 0.95, "timing": 0.6, "tempo_ratio": 0.8, "clean_runs": 3, "days": 2, "holds": True}
GATE_SOLID = {
    "accuracy": 0.98,
    "timing": 0.8,
    "tempo_ratio": 1.0,
    "window": 7,
    "clean_in_window": 5,
    "days": 3,
    "habit_free": True,
    "holds": True,
}
GATE_MASTERED = {
    "accuracy": 0.98,
    "timing": 0.8,
    "tempo_ratio": 1.0,
    "away_days": 7,
    "cold_runs": 3,
    "materials": 2,
    "holds": True,
}
DRILL = {"hands": "right", "bars": None, "mode": "wait", "tempo": 100}


def sight_step(i, reaction_ms, first_try=True):
    return {
        "step": i,
        "card": i,
        "notes": [60],
        "result": "hit" if first_try else "wrong",
        "first_try": first_try,
        "wrong_count": 0 if first_try else 1,
        "wrong_notes": [],
        "hinted": False,
        "reaction_ms": reaction_ms,
        "shown_page_ms": 1000,
        "done_page_ms": 1000 + reaction_ms,
    }


def sight_attempt(**over):
    base = {
        "id": "attempt-20261106-200000-aaaaaa",
        "version": 2,
        "kind": "rusty_piano.attempt",
        "score": {"id": "sight:r2-treble", "title": "Sight-reading: Treble C-G notes", "composer": None},
        "mode": "wait",
        "end": "done",
        "started_at": "2026-11-06T20:00:00.000Z",
        "ended_at": "2026-11-06T20:00:03.800Z",
        "duration_ms": 3800,
        "clock": {"page_start_ms": 1000, "t0_ms": None, "first_engine_t": None, "first_engine_page_ms": None},
        "practice": {"hands": "right", "range": None, "loop": False, "loops_completed": 0, "tempo": {"percent": 100}},
        "plan": {"steps_total": 3, "length_quarters": 0, "first_bar": None, "last_bar": None},
        "settings": {"sight": {"hint_after": 2, "seed": 42, "custom": None}},
        "autoplay": {"on_at_start": False, "used": False},
        "sources": ["engine"],
        "pedal_down_at_start": False,
        "sight": {
            "level": "r2-treble",
            "kind": "notes",
            "cards_total": 3,
            "steps_total": 3,
            "custom": None,
            "targets_ms": {"good": 2000, "solid": 1200, "mastered": 800},
        },
        "steps": [sight_step(0, 1000), sight_step(1, 1100), sight_step(2, 1200)],
        "events": [],
        "summary": {"counts": {}, "metrics": {}, "rows": [], "sight": {}},
        "drill_id": "sr.r2-treble",
        "plan_id": None,
        "tags": ["sight-reading"],
    }
    base.update(over)
    return base


def steps_at(ms):
    return [sight_step(0, ms)]


def test_is_sight_and_level_of():
    assert sight.is_sight("sight:r2-treble")
    assert not sight.is_sight("gen:abc")
    assert not sight.is_sight("sight")
    assert not sight.is_sight(None)
    assert sight.level_of("sight:r2-treble") == "r2-treble"
    assert sight.level_of("piece:bach") is None


def test_gate_level():
    assert sight.gate_level(GATE_GOOD) == "good"
    assert sight.gate_level(GATE_SOLID) == "solid"
    assert sight.gate_level(GATE_MASTERED) == "mastered"


def test_median_reaction_ms_odd_even_and_ignored_values():
    assert sight.median_reaction_ms([{"reaction_ms": 900}, {"reaction_ms": 100}, {"reaction_ms": 1300}]) == 900
    four = [{"reaction_ms": 1000}, {"reaction_ms": 1200}, {"reaction_ms": 1400}, {"reaction_ms": 1600}]
    assert sight.median_reaction_ms(four) == 1300
    pending = [{"reaction_ms": 500, "result": "pending"}, {"reaction_ms": 900}]
    assert sight.median_reaction_ms(pending) == 900
    junk = [{"reaction_ms": True}, {"reaction_ms": None}, {"reaction_ms": 700}]
    assert sight.median_reaction_ms(junk) == 700
    assert sight.median_reaction_ms([]) is None
    assert sight.median_reaction_ms([{"reaction_ms": None}]) is None


def test_speed_ok_notes():
    steps = steps_at(1100)
    assert sight.speed_ok("sight:r2-treble", steps, GATE_GOOD)
    assert sight.speed_ok("sight:r2-treble", steps, GATE_SOLID)
    assert not sight.speed_ok("sight:r2-treble", steps, GATE_MASTERED)


def test_speed_ok_intervals():
    steps = steps_at(2500)
    assert sight.speed_ok("sight:r5-intervals", steps, GATE_GOOD)
    assert not sight.speed_ok("sight:r5-intervals", steps, GATE_SOLID)


def test_speed_ok_bars():
    steps = steps_at(900)
    assert sight.speed_ok("sight:r8a-five", steps, GATE_SOLID)
    assert not sight.speed_ok("sight:r8a-five", steps, GATE_MASTERED)


def test_speed_ok_unknown_level_uses_notes_targets():
    steps = steps_at(1100)
    assert sight.speed_ok("sight:weird", steps, GATE_GOOD)
    assert not sight.speed_ok("sight:weird", steps, GATE_MASTERED)


def test_speed_ok_without_reaction_times_is_false():
    assert not sight.speed_ok("sight:r2-treble", [{"reaction_ms": None}], GATE_GOOD)
    assert not sight.speed_ok("sight:r2-treble", [], GATE_GOOD)


def test_is_clean_sight_speed_gate():
    fast = runs.runs_of_attempt(sight_attempt(steps=steps_at(1100)), UTC)[0]
    slow = runs.runs_of_attempt(sight_attempt(steps=steps_at(2500)), UTC)[0]
    assert runs.is_clean(fast, GATE_GOOD, DRILL)
    assert not runs.is_clean(slow, GATE_GOOD, DRILL)


def test_is_clean_non_sight_unchanged():
    other = sight_attempt(score={"id": "piece:bach", "title": "Bach", "composer": None}, steps=steps_at(2500))
    run = runs.runs_of_attempt(other, UTC)[0]
    assert runs.is_clean(run, GATE_GOOD, DRILL)


def test_sight_attempt_validates():
    attempts.validate_attempt(sight_attempt())


def test_history_order_fields_and_skips_non_sight(tmp_path):
    late = sight_attempt(started_at="2026-11-06T21:00:00Z")
    early = sight_attempt(started_at="2026-11-06T20:00:00Z")
    other = sight_attempt(score={"id": "piece:bach", "title": "Bach", "composer": None})
    attempts.save_attempt(tmp_path, late, now=datetime(2026, 11, 6, 21, 0, tzinfo=UTC))
    attempts.save_attempt(tmp_path, early, now=datetime(2026, 11, 6, 20, 0, tzinfo=UTC))
    attempts.save_attempt(tmp_path, other, now=datetime(2026, 11, 6, 22, 0, tzinfo=UTC))
    result = sight.history(tmp_path)
    rounds = result["rounds"]
    assert [r["started_at"] for r in rounds] == ["2026-11-06T20:00:00Z", "2026-11-06T21:00:00Z"]
    first = rounds[0]
    assert set(first) == {"id", "started_at", "level", "drill_id", "end", "accuracy", "median_ms", "steps"}
    assert first["level"] == "r2-treble"
    assert first["drill_id"] == "sr.r2-treble"
    assert first["end"] == "done"
    assert first["accuracy"] == 1.0
    assert first["median_ms"] == 1100
    assert first["steps"][0] == {
        "notes": [60],
        "first_try": True,
        "reaction_ms": 1000,
        "hinted": False,
        "wrong_count": 0,
    }


def test_history_level_filter(tmp_path):
    attempts.save_attempt(tmp_path, sight_attempt(), now=datetime(2026, 11, 6, 20, 0, tzinfo=UTC))
    bass = sight_attempt(
        score={"id": "sight:r3-bass", "title": "Bass", "composer": None},
        sight={"level": "r3-bass", "kind": "notes", "cards_total": 3, "steps_total": 3, "custom": None,
               "targets_ms": {"good": 2000, "solid": 1200, "mastered": 800}},
    )
    attempts.save_attempt(tmp_path, bass, now=datetime(2026, 11, 6, 21, 0, tzinfo=UTC))
    assert len(sight.history(tmp_path)["rounds"]) == 2
    assert [r["level"] for r in sight.history(tmp_path, level="r3-bass")["rounds"]] == ["r3-bass"]
    assert sight.history(tmp_path, level="r7-keys")["rounds"] == []


def test_history_limit_keeps_newest(tmp_path):
    for hour in (20, 21, 22):
        obj = sight_attempt(started_at=f"2026-11-06T{hour}:00:00Z")
        attempts.save_attempt(tmp_path, obj, now=datetime(2026, 11, 6, hour, 0, tzinfo=UTC))
    rounds = sight.history(tmp_path, limit=2)["rounds"]
    assert [r["started_at"] for r in rounds] == ["2026-11-06T21:00:00Z", "2026-11-06T22:00:00Z"]


def test_history_skips_malformed_step(tmp_path):
    bad = dict(sight_step(1, 900), notes="60")
    obj = sight_attempt(steps=[sight_step(0, 1000), bad])
    attempts.save_attempt(tmp_path, obj, now=datetime(2026, 11, 6, 20, 0, tzinfo=UTC))
    rounds = sight.history(tmp_path)["rounds"]
    assert len(rounds) == 1
    assert len(rounds[0]["steps"]) == 1


def test_habits_ignore_sight_attempts():
    attempts_list = []
    for i in range(5):
        steps = [sight_step(j, 1500, first_try=False) for j in range(3)]
        attempts_list.append(
            sight_attempt(
                id=f"attempt-2026110{i + 1}-200000-aaaaa{i + 1}",
                started_at=f"2026-11-0{i + 1}T20:00:00Z",
                steps=steps,
            )
        )
    run_list = [run for a in attempts_list for run in runs.runs_of_attempt(a, UTC)]
    candidates = habits.detect(run_list, attempts_list, [], None, None, {})
    assert not [c for c in candidates if (c["where"]["score"] or "").startswith("sight:")]


def test_build_evidence_keeps_sight_out_of_pieces(tmp_path):
    import json

    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "tree.json").write_text(json.dumps(tiny_tree()), encoding="utf-8")
    attempts_dir = tmp_path / "attempts"
    now = datetime(2026, 11, 6, 22, 0, tzinfo=UTC)
    attempts.save_attempt(attempts_dir, sight_attempt(), now=datetime(2026, 11, 6, 20, 0, tzinfo=UTC))
    gen = sight_attempt(
        score={"id": "gen:abc", "title": "Generated", "composer": None},
        drill_id="gen.abc",
        tags=[],
        started_at="2026-11-06T21:00:00Z",
    )
    gen_saved = attempts.save_attempt(attempts_dir, gen, now=datetime(2026, 11, 6, 21, 0, tzinfo=UTC))
    evidence = trends.build_evidence(
        attempts_dir=attempts_dir,
        reports_dir=tmp_path / "reports",
        plan_dir=plan_dir,
        scores_dir=tmp_path / "scores",
        since=None,
        today=date(2026, 11, 6),
        tz=UTC,
        now=now,
    )
    assert evidence["pending_analysis"] == [gen_saved["id"]]
    assert not [k for k in evidence["pieces"] if k.startswith("sight:")]
    assert "sr.r2-treble" in evidence["drills"]
