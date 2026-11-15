import copy
import json
from pathlib import Path

import pytest

from rusty_piano_coach import cli, plan

FIXTURE = Path(__file__).parents[1] / "web" / "tests" / "fixtures" / "drill-links.json"

GOOD = {"accuracy": 0.95, "timing": 0.9, "tempo_ratio": 0.8, "clean_runs": 3, "days": 2, "holds": True}
SOLID = {
    "accuracy": 0.98,
    "timing": 0.95,
    "tempo_ratio": 1.0,
    "window": 7,
    "clean_in_window": 5,
    "days": 3,
    "habit_free": True,
    "holds": True,
}
MASTERED = {
    "accuracy": 0.98,
    "timing": 0.95,
    "tempo_ratio": 1.0,
    "away_days": 7,
    "cold_runs": 3,
    "materials": 2,
    "holds": True,
}


def drill(id="r2.steps", score="gen:r2-steps"):
    return {
        "id": id,
        "title": "Steps",
        "score": score,
        "hands": "right",
        "mode": "wait",
        "tempo": 100,
        "loop": False,
        "bars": None,
        "goal": "clean",
        "kind": "generated",
    }


def node(id, requires=(), drills=None, **extra):
    n = {"id": id, "track": "reading", "title": "T " + id, "requires": list(requires), "drills": drills or []}
    n.update(extra)
    return n


def make_tree():
    return {
        "version": 1,
        "kind": "rusty_piano.tree",
        "decay_days": 30,
        "default_gates": {"good": dict(GOOD), "solid": dict(SOLID), "mastered": dict(MASTERED)},
        "tracks": [{"id": "reading", "title": "Reading"}],
        "nodes": [node("R1"), node("R2", ["R1"], [drill()])],
    }


def make_state():
    return {
        "version": 1,
        "kind": "rusty_piano.state",
        "updated_at": "2026-11-05T00:00:00Z",
        "last_review": None,
        "plan_id": None,
        "nodes": {},
        "habits": [],
    }


def write_plan(folder, tree=None, state=None):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "tree.json").write_text(json.dumps(tree or make_tree()), encoding="utf-8")
    if state is not None:
        (folder / "state.json").write_text(json.dumps(state), encoding="utf-8")


# schema interpreter


def test_schema_type_and_bool_is_not_number():
    assert plan.schema_errors("a", {"type": "integer"}) == [": expected integer"]
    assert plan.schema_errors(True, {"type": "integer"}) != []
    assert plan.schema_errors(True, {"type": "number"}) != []
    assert plan.schema_errors(None, {"type": ["string", "null"]}) == []
    assert plan.schema_errors(1.5, {"type": "number"}) == []


def test_schema_required_and_path():
    schema = {"type": "object", "required": ["level"], "properties": {"a": {"type": "array", "items": {"type": "string"}}}}
    assert plan.schema_errors({}, schema) == [": missing required key level"]
    assert plan.schema_errors({"level": 1, "a": ["x", 2]}, schema) == ["a[1]: expected string"]


def test_schema_enum_pattern_minmax():
    assert plan.schema_errors("x", {"enum": ["a", "b"]}) != []
    assert plan.schema_errors("a", {"enum": ["a", "b"]}) == []
    pat = {"type": "string", "pattern": "^[a-z]+$"}
    assert plan.schema_errors("abc", pat) == []
    assert plan.schema_errors("abc\n", pat) != []
    assert plan.schema_errors(0, {"minimum": 1}) != []
    assert plan.schema_errors(5, {"maximum": 4}) != []
    assert plan.schema_errors("", {"minLength": 1}) != []
    assert plan.schema_errors("abc", {"maxLength": 2}) != []
    assert plan.schema_errors([], {"minItems": 1}) != []
    assert plan.schema_errors([1, 2], {"maxItems": 1}) != []
    assert plan.schema_errors(2, {"const": 1}) != []
    assert plan.schema_errors(True, {"const": 1}) != []


def test_schema_additional_properties():
    assert plan.schema_errors({"a": 1}, {"type": "object", "additionalProperties": False}) == ["a: unexpected key"]
    sub = {"type": "object", "additionalProperties": {"type": "integer"}}
    assert plan.schema_errors({"a": 1}, sub) == []
    assert plan.schema_errors({"a": "x"}, sub) == ["a: expected integer"]


def test_schema_ref_and_property_names():
    schema = {
        "type": "object",
        "propertyNames": {"pattern": "^[A-Z]$"},
        "additionalProperties": {"$ref": "#/$defs/n"},
        "$defs": {"n": {"type": "integer"}},
    }
    assert plan.schema_errors({"A": 1}, schema) == []
    assert plan.schema_errors({"A": "x"}, schema) == ["A: expected integer"]
    assert plan.schema_errors({"a": 1}, schema) != []


def test_schema_unsupported_keyword():
    with pytest.raises(ValueError):
        plan.schema_errors(1, {"oneOf": []})


def test_schema_files_use_supported_keywords():
    def walk(schema):
        assert set(schema) <= plan.SUPPORTED_KEYWORDS, set(schema) - plan.SUPPORTED_KEYWORDS
        for sub in schema.get("$defs", {}).values():
            walk(sub)
        for sub in schema.get("properties", {}).values():
            walk(sub)
        for key in ("items", "propertyNames", "additionalProperties"):
            if isinstance(schema.get(key), dict):
                walk(schema[key])

    for name in ("tree.schema.json", "state.schema.json"):
        walk(plan.load_schema(name))


# tree


def test_valid_tree():
    assert plan.validate_tree(make_tree()) == []


def test_tree_schema_error_prefix():
    tree = make_tree()
    tree["nodes"][1]["drills"][0]["hands"] = "x"
    errors = plan.validate_tree(tree)
    assert errors and errors[0].startswith("tree.json: nodes[1].drills[0].hands")


def test_tree_duplicates():
    tree = make_tree()
    tree["nodes"].append(node("R1"))
    assert any("duplicate node id R1" in e for e in plan.validate_tree(tree))
    tree = make_tree()
    tree["nodes"][0]["drills"].append(drill())
    assert any("duplicate drill id r2.steps" in e for e in plan.validate_tree(tree))


def test_tree_prerequisites():
    tree = make_tree()
    tree["nodes"][1]["requires"] = ["R9"]
    assert any("unknown prerequisite R9" in e for e in plan.validate_tree(tree))
    tree = make_tree()
    tree["nodes"][1]["requires"] = ["R2"]
    assert any("requires itself" in e for e in plan.validate_tree(tree))
    tree = make_tree()
    tree["nodes"][0]["requires"] = ["R2"]
    assert any("prerequisite cycle" in e for e in plan.validate_tree(tree))


def test_tree_gate_floors():
    tree = make_tree()
    tree["nodes"][1]["gates"] = {"good": {"accuracy": 0.9}}
    assert "tree.json: nodes[1].gates.good.accuracy: 0.9 is below the floor 0.95" in plan.validate_tree(tree)
    tree = make_tree()
    tree["nodes"][1]["gates"] = {"good": {"timing": 0.1}}
    assert any("timing" in e and "below the floor" in e for e in plan.validate_tree(tree))
    tree = make_tree()
    tree["nodes"][1]["gates"] = {"solid": {"window": 8}}
    assert any("window" in e for e in plan.validate_tree(tree))
    tree = make_tree()
    tree["nodes"][1]["gates"] = {"solid": {"habit_free": False}}
    assert any("habit_free" in e for e in plan.validate_tree(tree))
    tree = make_tree()
    tree["default_gates"]["mastered"]["holds"] = False
    assert any("holds" in e for e in plan.validate_tree(tree))


def test_tree_piece_and_track():
    tree = make_tree()
    tree["nodes"].append(node("piece-ode", kind="piece"))
    assert any("piece node needs a score" in e for e in plan.validate_tree(tree))
    tree = make_tree()
    tree["nodes"][0]["track"] = "nope"
    assert any("unknown track nope" in e for e in plan.validate_tree(tree))


# state


def test_state_level_above_max():
    state = make_state()
    state["nodes"]["R1"] = {"level": 3, "max_level": 1}
    errors, _ = plan.validate_state(state, make_tree())
    assert errors == ["state.json: nodes.R1: level 3 is above the gate floor (max 1)"]


def test_state_unknown_node_and_habit():
    state = make_state()
    state["nodes"]["R7"] = {"level": 1}
    errors, _ = plan.validate_state(state, make_tree())
    assert any("nodes.R7" in e for e in errors)
    state = make_state()
    state["nodes"]["R1"] = {"level": 1, "habits": ["H1"]}
    errors, _ = plan.validate_state(state, make_tree())
    assert any("unknown habit H1" in e for e in errors)
    state = make_state()
    state["habits"] = [{"id": "H1", "title": "x", "status": "active", "nodes": ["R9"]}]
    errors, _ = plan.validate_state(state, make_tree())
    assert any("unknown node R9" in e for e in errors)


def test_state_locked_warning():
    state = make_state()
    state["nodes"]["R2"] = {"level": 2}
    errors, warnings = plan.validate_state(state, make_tree())
    assert errors == []
    assert warnings == ["state.json: nodes.R2: level 2 while locked"]


# today and links


def test_check_today_unknown_drill():
    text = "[a](http://localhost:5173/#gen:r2-steps?drill=r2.steps) [b](#gen:x?drill=r9.nope)"
    assert plan.check_today(text, make_tree()) == ["today.md: link to unknown drill 'r9.nope'"]


def test_fixture_round_trip():
    entries = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert entries
    for e in entries:
        assert plan.drill_hash(e["score"], e["params"]) == e["hash"], e["name"]
        assert plan.parse_drill_hash(e["hash"]) == (e["score"], e["params"] or None), e["name"]


def test_parse_non_score_routes():
    assert plan.parse_drill_hash("#/skills") == (None, None)
    assert plan.parse_drill_hash("") == (None, None)
    assert plan.parse_drill_hash("#nocolon") == (None, None)
    assert plan.parse_drill_hash("#score=local:a") == ("local:a", None)
    assert plan.parse_drill_hash("#a:b?tempo=5x&mode=wait") == ("a:b", {"mode": "wait"})
    assert plan.parse_drill_hash("#a:b?ramp=2&target=x&mode=wait") == ("a:b", {"mode": "wait"})


# init and cli


def seed(tmp_path, monkeypatch):
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(make_tree()), encoding="utf-8")
    monkeypatch.setattr(plan, "SEED_TREE", path)


def test_init_plan(tmp_path, monkeypatch):
    seed(tmp_path, monkeypatch)
    folder = tmp_path / "plan"
    created = plan.init_plan(folder)
    assert created
    for name in ("tree.json", "state.json", "journal", "pieces"):
        assert (folder / name).exists()
    assert plan.init_plan(folder) == []


def test_init_missing_seed(tmp_path, monkeypatch):
    monkeypatch.setattr(plan, "SEED_TREE", tmp_path / "none.json")
    with pytest.raises(FileNotFoundError):
        plan.init_plan(tmp_path / "plan")


def test_cli_check(tmp_path, capsys):
    folder = tmp_path / "plan"
    write_plan(folder, state=make_state())
    assert cli.main(["plan", "check", "--plan-dir", str(folder)]) == 0
    assert "Plan OK: 2 nodes, 1 drills" in capsys.readouterr().out
    bad = make_state()
    bad["nodes"]["R9"] = {"level": 1}
    write_plan(folder, state=bad)
    assert cli.main(["plan", "check", "--plan-dir", str(folder)]) == 1
    assert "error: state.json: nodes.R9" in capsys.readouterr().out


def test_cli_check_missing(tmp_path, capsys):
    assert cli.main(["plan", "check", "--plan-dir", str(tmp_path / "none")]) == 1
    assert "tree.json: missing; run coach plan init" in capsys.readouterr().out


def test_cli_init(tmp_path, monkeypatch, capsys):
    seed(tmp_path, monkeypatch)
    folder = tmp_path / "plan"
    assert cli.main(["plan", "init", "--plan-dir", str(folder)]) == 0
    assert "created" in capsys.readouterr().out
    assert cli.main(["plan", "init", "--plan-dir", str(folder)]) == 0
    assert "Plan files already exist" in capsys.readouterr().out


def test_cli_link_drill(tmp_path, capsys):
    folder = tmp_path / "plan"
    write_plan(folder)
    assert cli.main(["plan", "link", "r2.steps", "--plan-dir", str(folder), "--plan", "2026-11-05"]) == 0
    assert capsys.readouterr().out.strip() == (
        "http://localhost:5173/#gen:r2-steps?drill=r2.steps&plan=2026-11-05&hands=R&tempo=100&mode=wait&loop=0"
    )
    assert cli.main(["plan", "link", "r9.no", "--plan-dir", str(folder)]) == 1


def test_cli_link_score(tmp_path, capsys):
    args = ["plan", "link", "--plan-dir", str(tmp_path), "--score", "local:abc", "--hands", "left", "--bars", "5-8", "--loop"]
    assert cli.main(args) == 0
    assert capsys.readouterr().out.strip() == "http://localhost:5173/#local:abc?hands=L&bars=5-8&loop=1"
    assert cli.main(["plan", "link", "--plan-dir", str(tmp_path)]) == 2
    assert "give a drill id or --score" in capsys.readouterr().out


def test_cli_link_ramp(tmp_path, capsys):
    args = ["plan", "link", "--plan-dir", str(tmp_path), "--score", "local:abc", "--loop", "--ramp", "--target", "90"]
    assert cli.main(args) == 0
    assert capsys.readouterr().out.strip() == "http://localhost:5173/#local:abc?loop=1&ramp=1&target=90"
    assert cli.main(["plan", "link", "--plan-dir", str(tmp_path), "--score", "local:abc", "--target", "0"]) == 2
    assert "error: --target must be 1-300" in capsys.readouterr().out


def test_tree_cold_runs_per_drill_floor():
    tree = make_tree()
    tree["default_gates"]["mastered"]["cold_runs_per_drill"] = 1
    assert "tree.json: nodes[0].gates.mastered.cold_runs_per_drill: 1 is below the floor 2" in plan.validate_tree(tree)
    tree = make_tree()
    tree["default_gates"]["mastered"]["cold_runs_per_drill"] = 2
    assert plan.validate_tree(tree) == []
    tree = make_tree()
    assert plan.validate_tree(tree) == []
    tree["default_gates"]["mastered"]["cold_runs_per_drill"] = "x"
    assert any("cold_runs_per_drill" in e for e in plan.validate_tree(tree))


def test_tree_ramp_and_target():
    tree = make_tree()
    d = tree["nodes"][1]["drills"][0]
    d.update(loop=True, ramp=True, target=90)
    assert plan.validate_tree(tree) == []
    d["target"] = 0
    assert any("target" in e for e in plan.validate_tree(tree))
    d["target"] = 301
    assert any("target" in e for e in plan.validate_tree(tree))
    d["target"] = 90
    d["ramp"] = "yes"
    assert any("ramp" in e for e in plan.validate_tree(tree))
    d["ramp"] = True
    d["loop"] = False
    assert "tree.json: nodes[1].drills[0].ramp: a ramp needs loop true" in plan.validate_tree(tree)


def test_cli_link_drill_ramp_and_target(tmp_path, capsys):
    tree = make_tree()
    tree["nodes"][1]["drills"][0].update(loop=True, ramp=True, target=90)
    folder = tmp_path / "plan"
    write_plan(folder, tree)
    assert cli.main(["plan", "link", "r2.steps", "--plan-dir", str(folder)]) == 0
    assert capsys.readouterr().out.strip() == (
        "http://localhost:5173/#gen:r2-steps?drill=r2.steps&hands=R&tempo=100&mode=wait&loop=1&ramp=1&target=90"
    )
