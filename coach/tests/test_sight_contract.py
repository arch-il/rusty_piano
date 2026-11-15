import copy
import json
from datetime import date, timezone
from pathlib import Path

from rusty_piano_coach import attempts, gates, plan, runs, sight

FIXTURES = Path(__file__).parents[1] / "web" / "tests" / "fixtures"
AID = "attempt-20261106-200000-a1b2c3"


def seed():
    return plan.load_json(plan.SEED_TREE)


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def with_id(obj, aid=AID, started=None):
    obj = copy.deepcopy(obj)
    obj["id"] = aid
    if started is not None:
        obj["started_at"] = started
    return obj


def test_level_fixture_matches_code_and_seed_tree():
    tree = seed()
    index = plan.drill_index(tree)
    spec = fixture("sight-levels.json")
    for entry in spec["levels"]:
        assert sight.LEVEL_KINDS[entry["level"]] == entry["kind"]
        node, drill = index[entry["drill"]]
        assert node["id"] == entry["node"]
        assert drill["score"] == "sight:" + entry["level"]
        assert drill["hands"] == entry["hands"]
    assert spec["targets_ms"] == sight.TARGETS_MS
    custom = spec["custom"]
    assert custom["level"] in sight.LEVEL_KINDS
    assert custom["drill"] not in index


def test_attempt_fixture_is_valid_and_clean_for_good_and_solid_only():
    tree = seed()
    r2 = next(n for n in tree["nodes"] if n["id"] == "R2")
    gate = plan.merged_gates(tree, r2)
    drill = plan.drill_index(tree)["sr.r2-treble"][1]
    obj = with_id(fixture("sight-attempt.json"))
    attempts.validate_attempt(obj)
    run = runs.runs_of_attempt(obj, timezone.utc)[0]
    assert runs.is_clean(run, gate["good"], drill) is True
    assert runs.is_clean(run, gate["solid"], drill) is True
    assert runs.is_clean(run, gate["mastered"], drill) is False


def test_slow_round_is_not_clean_for_good():
    tree = seed()
    r2 = next(n for n in tree["nodes"] if n["id"] == "R2")
    gate = plan.merged_gates(tree, r2)
    drill = plan.drill_index(tree)["sr.r2-treble"][1]
    obj = with_id(fixture("sight-attempt.json"))
    for step in obj["steps"]:
        step["reaction_ms"] *= 2
    run = runs.runs_of_attempt(obj, timezone.utc)[0]
    assert runs.is_clean(run, gate["good"], drill) is False


def test_three_rounds_on_two_days_meet_good_for_r2():
    tree = seed()
    base = fixture("sight-attempt.json")
    found = []
    for aid, started in [
        ("attempt-20261106-200000-a1b2c3", "2026-11-06T20:00:00.000Z"),
        ("attempt-20261106-201000-a1b2c4", "2026-11-06T20:10:00.000Z"),
        ("attempt-20261107-200000-a1b2c5", "2026-11-07T20:00:00.000Z"),
    ]:
        found += runs.runs_of_attempt(with_id(base, aid, started), timezone.utc)
    progress = gates.node_progress(tree, None, found, date(2026, 11, 7))
    good = progress["R2"]["drills"]["sr.r2-treble"]["good"]
    assert good["clean_runs"] == 3
    assert good["days"] == 2
    assert good["met"] is True
    node_good = progress["R2"]["gates"]["good"]
    assert node_good["met"] is False
    assert "sr.r2-treble" not in node_good["missing"]
