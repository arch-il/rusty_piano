import copy
import json
from datetime import timezone
from pathlib import Path

from rusty_piano_coach import attempts, ear, plan, runs

FIXTURES = Path(__file__).parents[1] / "web" / "tests" / "fixtures"
AID = "attempt-20261108-100000-a1b2c3"


def seed():
    return plan.load_json(plan.SEED_TREE)


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def with_id(obj, aid=AID):
    obj = copy.deepcopy(obj)
    obj["id"] = aid
    return obj


def e1_gate_and_drill():
    tree = seed()
    e1 = next(n for n in tree["nodes"] if n["id"] == "E1")
    gate = plan.merged_gates(tree, e1)
    drill = plan.drill_index(tree)["ear.echo-1"][1]
    return gate, drill


def test_level_fixture_matches_code_and_seed_tree():
    index = plan.drill_index(seed())
    spec = fixture("ear-levels.json")
    for entry in spec["levels"]:
        assert ear.LEVEL_KINDS[entry["level"]] == entry["kind"]
        node, drill = index[entry["drill"]]
        assert node["id"] == entry["node"]
        assert drill["score"] == "ear:" + entry["level"]
        assert drill["hands"] == "both"
        assert drill["mode"] == "wait"
        assert drill["title"] == "Ear: " + entry["title"]
    assert spec["targets_ms"] == ear.TARGETS_MS


def test_seed_ear_drills_are_exactly_the_fixture_drills():
    spec = fixture("ear-levels.json")
    seed_ear = {
        d["id"]
        for n in seed()["nodes"]
        if n["track"] == "ear"
        for d in n["drills"]
    }
    assert seed_ear == {e["drill"] for e in spec["levels"]}
    assert len(seed_ear) == 22


def test_attempt_fixture_is_valid_and_clean_for_good_and_solid_only():
    gate, drill = e1_gate_and_drill()
    obj = with_id(fixture("ear-attempt.json"))
    attempts.validate_attempt(obj)
    run = runs.runs_of_attempt(obj, timezone.utc)[0]
    assert runs.is_clean(run, gate["good"], drill) is True
    assert runs.is_clean(run, gate["solid"], drill) is True
    assert runs.is_clean(run, gate["mastered"], drill) is False


def test_attempt_fixture_median_matches_python():
    obj = fixture("ear-attempt.json")
    assert ear.median_step_ms(obj["steps"]) == obj["ear"]["median_step_ms"]


def test_slow_round_is_not_clean_for_good():
    gate, drill = e1_gate_and_drill()
    obj = with_id(fixture("ear-attempt.json"))
    for step in obj["steps"]:
        step["response_ms"] *= 3
    run = runs.runs_of_attempt(obj, timezone.utc)[0]
    assert runs.is_clean(run, gate["good"], drill) is False


def test_history_of_the_fixture_round(tmp_path):
    attempts.save_attempt(tmp_path, with_id(fixture("ear-attempt.json")))
    rounds = ear.history(tmp_path)["rounds"]
    assert len(rounds) == 1
    r = rounds[0]
    assert r["accuracy"] == 1.0
    assert r["median_step_ms"] == 2400.0
    assert r["replays"] == 1
    assert [i["category"] for i in r["items"]] == ["C4", "E4", "G4"]
