import argparse
import json
from datetime import date, datetime, timezone

from rusty_piano_coach import plan, trends
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.server import handle_request

GATES = {
    "good": {"accuracy": 0.95, "timing": 0.6, "tempo_ratio": 0.8, "clean_runs": 3, "days": 2, "holds": True},
    "solid": {"accuracy": 0.98, "timing": 0.8, "tempo_ratio": 1.0, "window": 7, "clean_in_window": 5, "days": 3, "habit_free": True, "holds": True},
    "mastered": {"accuracy": 0.98, "timing": 0.8, "tempo_ratio": 1.0, "away_days": 7, "cold_runs": 3, "cold_runs_per_drill": 2, "materials": 2, "holds": True},
}
TRACKS = [{"id": t, "title": t} for t in ("technique", "scales", "coordination", "expression", "pieces")]
SUFFIX = {
    4: ("c-rh", "c-lh", "g-rh", "g-lh", "f-rh", "f-lh"),
    5: ("c-to-g", "octave-rh", "octave-lh", "c-to-a", "no-rest"),
    6: ("c-chord-rh", "c-chord-lh", "c-g7-rh", "c-f-g-lh", "chords-quarters"),
    7: ("broken-c-rh", "broken-lh", "alberti-lh", "arpeggio-rh", "broken-c-f-g"),
}
TOP = f"K{max(SUFFIX)}"
FIX = "technique K4 removed (it repeated S1), later technique nodes moved down by one"


def drill(did, score, hands="right"):
    return {"id": did, "kind": "generated", "title": "x", "score": score, "hands": hands, "mode": "live", "tempo": 100, "loop": False, "bars": None, "goal": ""}


def node(nid, track, requires, drills):
    return {"id": nid, "kind": "skill", "track": track, "title": nid, "requires": requires, "drills": drills}


def tech(n, new_n, requires):
    out = node(f"K{new_n}", "technique", requires, [drill(f"k{new_n}.{s}", f"gen:k{new_n}-{s}") for s in SUFFIX[n]])
    out["title"] = SUFFIX[n][0]
    return out


def tree_doc(nodes):
    return {"version": 1, "kind": "rusty_piano.tree", "decay_days": 30, "default_gates": GATES, "tracks": TRACKS, "nodes": nodes}


def piece(requires):
    return {
        "id": "piece-little-waltz",
        "kind": "piece",
        "track": "pieces",
        "title": "Little Waltz",
        "requires": requires,
        "score": "gen:piece-little-waltz",
        "drills": [drill("piece.little-waltz", "gen:piece-little-waltz", "both")],
    }


def old_tree(with_k4=True):
    nodes = [
        node("K1", "technique", [], [drill("k1.c5-rh", "gen:k1-c5-rh")]),
        node("K2", "technique", ["K1"], [drill("k2.legato-rh", "gen:k2-legato-rh")]),
        node("S1", "scales", [], [drill("scales.c-major", "scales:c-major-1oct-rh")]),
    ]
    if with_k4:
        nodes.append(tech(4, 4, ["K2"]))
    nodes += [
        tech(5, 5, ["K4"] if with_k4 else ["K2", "S1"]),
        tech(6, 6, ["K5"]),
        tech(7, 7, ["K6"]),
        node("C4", "coordination", [], [drill("c4.a", "gen:c4-a")]),
        node("D1", "expression", [], [drill("d1.a", "gen:d1-a")]),
        piece(["C4", "K6", "D1"]),
    ]
    return tree_doc(nodes)


def new_tree():
    nodes = [
        node("K1", "technique", [], [drill("k1.c5-rh", "gen:k1-c5-rh")]),
        node("K2", "technique", ["K1"], [drill("k2.legato-rh", "gen:k2-legato-rh")]),
        node("S1", "scales", [], [drill("scales.c-major", "scales:c-major-1oct-rh")]),
        tech(5, 4, ["K2", "S1"]),
        tech(6, 5, ["K4"]),
        tech(7, 6, ["K5"]),
        node("C4", "coordination", [], [drill("c4.a", "gen:c4-a")]),
        node("D1", "expression", [], [drill("d1.a", "gen:d1-a")]),
        piece(["C4", "K5", "D1"]),
    ]
    return tree_doc(nodes)


def old_state(with_k4=True):
    nodes = {"K1": {"level": 2, "runs": 2}, "K2": {"level": 2, "runs": 2}}
    if with_k4:
        nodes["K4"] = {"level": 2, "runs": 4}
    nodes["K5"] = {"level": 2, "runs": 5}
    nodes["K6"] = {"level": 2, "runs": 6}
    nodes[TOP] = {"level": 2, "runs": 7}
    habit_nodes = ["K2", "K4", "K5", TOP] if with_k4 else ["K2", "K5", TOP]
    return {
        "version": 1,
        "kind": "rusty_piano.state",
        "updated_at": "2026-11-17T00:00:00Z",
        "last_review": None,
        "plan_id": None,
        "nodes": nodes,
        "habits": [{"id": "H1", "title": "Stops", "status": "active", "nodes": habit_nodes}],
    }


def new_state():
    nodes = {
        "K1": {"level": 2, "runs": 2},
        "K2": {"level": 2, "runs": 2},
        "K4": {"level": 2, "runs": 5},
        "K5": {"level": 2, "runs": 6},
        "K6": {"level": 2, "runs": 7},
    }
    return {
        "version": 1,
        "kind": "rusty_piano.state",
        "updated_at": "2026-11-17T00:00:00Z",
        "last_review": None,
        "plan_id": None,
        "nodes": nodes,
        "habits": [{"id": "H1", "title": "Stops", "status": "active", "nodes": ["K2", "K4", "K6"]}],
    }


def dump(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def write(base, tree_bytes, state_bytes=None):
    plan_dir = base / "plan"
    plan_dir.mkdir(parents=True)
    (plan_dir / "tree.json").write_bytes(tree_bytes)
    if state_bytes is not None:
        (plan_dir / "state.json").write_bytes(state_bytes)
    return plan_dir


def no_tmp(plan_dir):
    return not list(plan_dir.glob(".*.tmp")) and not list(plan_dir.glob("*.tmp"))


def test_full_old_plan(tmp_path):
    state = old_state()
    state["habits"].append({"id": "H2", "title": "Thumb", "status": "active", "nodes": ["K4"]})
    plan_dir = write(tmp_path, dump(old_tree()).encode(), dump(state).encode())
    assert plan.migrate_technique(plan_dir) is True
    assert json.loads((plan_dir / "tree.json").read_bytes()) == new_tree()
    new = json.loads((plan_dir / "state.json").read_bytes())
    assert new["habits"][1]["nodes"] == []
    expected = new_state()
    expected["habits"].append({"id": "H2", "title": "Thumb", "status": "active", "nodes": []})
    assert new == expected
    assert list(new["nodes"]) == ["K1", "K2", "K4", "K5", "K6"]
    assert plan.check_plan(plan_dir)[0] == []


def test_half_migrated_plan(tmp_path):
    plan_dir = write(tmp_path, dump(old_tree(with_k4=False)).encode(), dump(old_state(with_k4=False)).encode())
    assert plan.migrate_technique(plan_dir) is True
    assert json.loads((plan_dir / "tree.json").read_bytes()) == new_tree()
    new = json.loads((plan_dir / "state.json").read_bytes())
    assert new == new_state()
    assert list(new["nodes"]) == ["K1", "K2", "K4", "K5", "K6"]
    assert plan.check_plan(plan_dir)[0] == []


def test_idempotent(tmp_path):
    plan_dir = write(tmp_path, dump(old_tree()).encode(), dump(old_state()).encode())
    assert plan.migrate_technique(plan_dir) is True
    tree = (plan_dir / "tree.json").read_bytes()
    state = (plan_dir / "state.json").read_bytes()
    assert plan.migrate_technique(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == tree
    assert (plan_dir / "state.json").read_bytes() == state


def test_custom_k4_untouched(tmp_path):
    tree = old_tree()
    k4 = next(n for n in tree["nodes"] if n["id"] == "K4")
    k4["drills"][-1] = drill("k4.d-rh", "gen:k4-d-rh")
    plan_dir = write(tmp_path, dump(tree).encode(), dump(old_state()).encode())
    tree_bytes = (plan_dir / "tree.json").read_bytes()
    state_bytes = (plan_dir / "state.json").read_bytes()
    assert plan.migrate_technique(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == tree_bytes
    assert (plan_dir / "state.json").read_bytes() == state_bytes
    assert no_tmp(plan_dir)


def test_new_plan_untouched(tmp_path):
    tree_bytes = dump(new_tree()).encode()
    state_bytes = dump(new_state()).encode()
    plan_dir = write(tmp_path, tree_bytes, state_bytes)
    assert plan.migrate_technique(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == tree_bytes
    assert (plan_dir / "state.json").read_bytes() == state_bytes


def test_keeps_layout(tmp_path):
    tree_crlf = dump(old_tree()).replace("\n", "\r\n").encode()
    state_no_newline = json.dumps(old_state(), indent=2).encode()
    plan_dir = write(tmp_path, tree_crlf, state_no_newline)
    assert plan.migrate_technique(plan_dir) is True
    assert (plan_dir / "tree.json").read_bytes() == dump(new_tree()).replace("\n", "\r\n").encode()
    assert (plan_dir / "state.json").read_bytes() == json.dumps(new_state(), indent=2, ensure_ascii=False).encode()

    one_line = write(tmp_path / "one", json.dumps(old_tree()).encode())
    assert plan.migrate_technique(one_line) is True
    new = (one_line / "tree.json").read_bytes()
    assert b"\n" not in new
    assert json.loads(new) == new_tree()


def test_no_state_file(tmp_path):
    plan_dir = write(tmp_path, dump(old_tree()).encode())
    assert plan.migrate_technique(plan_dir) is True
    assert json.loads((plan_dir / "tree.json").read_bytes()) == new_tree()
    assert not (plan_dir / "state.json").exists()


def test_bad_state_json(tmp_path):
    tree_bytes = dump(old_tree()).encode()
    plan_dir = write(tmp_path, tree_bytes, b"{not json")
    assert plan.migrate_technique(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == tree_bytes
    assert no_tmp(plan_dir)


def test_state_follow_up(tmp_path):
    tree_bytes = dump(new_tree()).encode()
    plan_dir = write(tmp_path, tree_bytes, dump(old_state()).encode())
    assert plan.migrate_technique(plan_dir) is True
    assert (plan_dir / "tree.json").read_bytes() == tree_bytes
    assert json.loads((plan_dir / "state.json").read_bytes()) == new_state()


def test_other_files_untouched(tmp_path):
    plan_dir = write(tmp_path, dump(old_tree()).encode(), dump(old_state()).encode())
    (plan_dir / "journal").mkdir()
    (plan_dir / "pieces").mkdir()
    (plan_dir / "journal" / "2026-11.md").write_text("journal\n", encoding="utf-8")
    (plan_dir / "today.md").write_text("today\n", encoding="utf-8")
    (plan_dir / "pieces" / "a.md").write_text("thumb-under scales (K4)\n", encoding="utf-8")
    others = {p: p.read_bytes() for p in (plan_dir / "journal" / "2026-11.md", plan_dir / "today.md", plan_dir / "pieces" / "a.md")}
    assert plan.migrate_technique(plan_dir) is True
    for p, data in others.items():
        assert p.read_bytes() == data


def test_plan_check_prints_fixed(tmp_path, capsys):
    plan_dir = write(tmp_path, dump(old_tree()).encode(), dump(old_state()).encode())
    args = argparse.Namespace(plan_command="check", plan_dir=str(plan_dir))
    assert plan.run_plan(args) == 0
    lines = capsys.readouterr().out.splitlines()
    fixed = lines.index(f"fixed: tree.json, state.json: {FIX}")
    ok = next(i for i, line in enumerate(lines) if line.startswith("Plan OK"))
    assert fixed < ok
    assert plan.run_plan(args) == 0
    assert "fixed:" not in capsys.readouterr().out


def test_server_fixes_plan(tmp_path):
    plan_dir = write(tmp_path, dump(old_tree()).encode(), dump(old_state()).encode())
    r = handle_request(tmp_path / "lib", "/api/plan", "GET", {"Host": "127.0.0.1:8765"}, Jobs(), plan_dir=plan_dir)
    assert r.status == 200
    ids = [n["id"] for n in json.loads(r.body)["tree"]["nodes"]]
    assert "K4" in ids
    assert TOP not in ids
    assert json.loads((plan_dir / "state.json").read_bytes()) == new_state()


def test_build_evidence_warns(tmp_path):
    plan_dir = write(tmp_path, dump(old_tree()).encode(), dump(old_state()).encode())
    ev = trends.build_evidence(
        attempts_dir=tmp_path / "attempts",
        reports_dir=tmp_path / "reports",
        plan_dir=plan_dir,
        scores_dir=tmp_path / "scores",
        since=None,
        today=date(2026, 11, 5),
        tz=timezone.utc,
        now=datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc),
    )
    assert f"tree.json, state.json: {FIX} (one-off fix)" in ev["warnings"]
