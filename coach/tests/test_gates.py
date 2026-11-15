import json
from datetime import date, datetime, timedelta, timezone

from evidence_fixtures import make_attempt, make_steps, tiny_tree, write_attempts

from rusty_piano_coach import gates, plan, runs, trends
from rusty_piano_coach.cli import main

UTC = timezone.utc
TODAY = date(2026, 11, 5)
BASE = datetime(2026, 9, 1, 10, 0, tzinfo=UTC)
COUNTER = [0]


def att(day, **kw):
    COUNTER[0] += 1
    n = COUNTER[0]
    kw.setdefault("drill_id", "t1.q")
    kw["id"] = f"attempt-{n:08d}-100000-aaaaaa"
    kw["started_at"] = (BASE + timedelta(days=day, minutes=n)).isoformat()
    return make_attempt(**kw)


def bad(day, **kw):
    return att(day, steps=make_steps(["hit"] * 10 + ["wrong"] * 6), **kw)


def prog(attempts, tree=None, state=None, today=TODAY):
    tree = tree or tiny_tree()
    rs = runs.load_runs(attempts, UTC)
    return gates.node_progress(tree, state or {"nodes": {}, "habits": []}, rs, today)


def t1(attempts, **kw):
    return prog(attempts, **kw)["T1"]


def test_no_runs():
    p = t1([])
    assert p["max_level"] == 0
    assert p["gates"]["good"]["met"] is False
    assert p["last_seen"] is None and p["last_clean"] is None


def test_tree_none():
    assert gates.node_progress(None, None, [], TODAY) == {}


def test_one_run():
    assert t1([att(0)])["max_level"] == 1


def test_good_met():
    p = t1([att(0), att(0), att(1)])
    assert p["gates"]["good"]["met"] is True
    assert p["max_level"] == 2


def test_good_one_day_not_met():
    p = t1([att(0), att(0), att(0)])
    assert p["gates"]["good"]["met"] is False
    assert p["drills"]["t1.q"]["good"]["clean_runs"] == 3
    assert p["max_level"] == 1


def test_stopped_and_slow_not_clean():
    p = t1([att(0, end="stopped"), att(1, tempo_percent=70), att(2, end="stopped")])
    assert p["drills"]["t1.q"]["good"]["clean_runs"] == 0


def test_solid_met_and_not():
    five = [att(0), att(1), att(2), att(2), att(2)] + [bad(3), bad(3)]
    p = t1(five)
    assert p["gates"]["solid"]["met"] is True
    assert p["max_level"] == 3
    four = [att(0), att(1), att(2), att(2)] + [bad(3)] * 3
    p = t1(four)
    assert p["gates"]["solid"]["met"] is False
    assert p["drills"]["t1.q"]["solid"]["clean_in_window"] == 4


def solid_attempts():
    return [att(0), att(1), att(2), att(2), att(2)]


def test_habit_blocks_solid():
    state = {"nodes": {}, "habits": [{"id": "h", "title": "h", "status": "active", "nodes": ["T1"]}]}
    p = t1(solid_attempts(), state=state)
    assert p["gates"]["solid"]["habit_free"] is False
    assert p["gates"]["solid"]["met"] is False
    state["habits"][0]["status"] = "improving"
    p = t1(solid_attempts(), state=state)
    assert p["gates"]["solid"]["habit_free"] is True
    assert p["gates"]["solid"]["met"] is True


def solid_runs():
    return [att(0), att(1), att(2), att(2), att(2)]


def test_mastered():
    p = t1(solid_runs() + [att(12), att(24)])
    m = p["gates"]["mastered"]
    assert p["drills"]["t1.q"]["mastered"]["cold_runs"] == 2
    assert m["met"] is True
    assert "materials" not in m
    assert p["max_level"] == 4


def test_mastered_one_cold_run():
    p = t1(solid_runs() + [att(12)])
    m = p["gates"]["mastered"]
    assert p["drills"]["t1.q"]["mastered"]["cold_runs"] == 1
    assert m["met"] is False
    assert p["max_level"] == 3


def test_locked():
    state = {"nodes": {"T1": {"level": 1}}, "habits": []}
    assert prog([], state=state)["T2"]["locked"] is True
    state["nodes"]["T1"]["level"] = 2
    assert prog([], state=state)["T2"]["locked"] is False
    assert prog([], state=state)["T1"]["locked"] is False


def test_rusty():
    state = {"nodes": {"T1": {"level": 3}}, "habits": []}
    old = TODAY - BASE.date()
    p = t1([att(old.days - 30)], state=state)
    assert p["rusty"] is True
    p = t1([att(old.days - 29)], state=state)
    assert p["rusty"] is False
    assert t1([att(old.days - 30)])["rusty"] is False


def test_loop_cycles_separate_runs():
    steps = make_steps(["hit"] * 8, cycle=1) + make_steps(["hit"] * 8, cycle=2) + make_steps(["hit"] * 8, cycle=3)
    a = att(0, loop=True, steps=steps, steps_total=8)
    assert t1([a])["runs"] == 3


def test_piece_node():
    tree = tiny_tree()
    tree["nodes"].append(
        {
            "id": "P1",
            "kind": "piece",
            "track": "rhythm",
            "title": "Piece",
            "summary": "Piece",
            "requires": [],
            "measures": ["pitch"],
            "score": "local:abc",
        }
    )
    good = [att(0, score="local:abc", drill_id=None, hands="both"), att(1, score="local:abc", drill_id=None, hands="both")]
    other = [
        att(2, score="local:abc", drill_id=None, hands="right"),
        att(2, score="local:abc", drill_id=None, hands="both", mode="wait"),
        att(2, score="local:abc", drill_id=None, hands="both", range={"from": 1, "to": 2}),
        att(2, score="gen:x", drill_id=None, hands="both"),
    ]
    p = prog(good + other, tree=tree)["P1"]
    assert p["kind"] == "piece"
    assert p["runs"] == 5
    assert p["gates"]["good"]["clean_runs"] == 2
    assert "drills" not in p
    assert "materials" in p["gates"]["mastered"]


def test_apply_to_state():
    state = {
        "version": 1,
        "last_review": "x",
        "plan_id": "p",
        "nodes": {"T1": {"level": 3, "verdict": "ok", "habits": ["h"]}},
        "habits": [{"id": "h", "title": "h", "status": "fixed", "nodes": []}],
    }
    p = prog([att(0)], state=state)
    new = gates.apply_to_state(state, p)
    t = new["nodes"]["T1"]
    assert (t["level"], t["verdict"], t["habits"]) == (1, "ok", ["h"])
    assert t["max_level"] == 1 and "good" in t["gates"]
    assert new["nodes"]["T2"]["level"] == 0
    assert new["nodes"]["T2"]["verdict"] == ""
    assert new["habits"] == state["habits"]
    assert new["last_review"] == "x" and new["plan_id"] == "p"
    assert "max_level" not in state["nodes"]["T1"]
    assert list(new["nodes"]) == ["T1", "T2", "R1"]


def test_cli_update_state(tmp_path):
    pd = tmp_path / "plan"
    pd.mkdir()
    tree = tiny_tree()
    (pd / "tree.json").write_text(json.dumps(tree), encoding="utf-8")
    state = {
        "version": 1,
        "kind": "rusty_piano.state",
        "updated_at": "2020-01-01T00:00:00Z",
        "last_review": None,
        "plan_id": None,
        "nodes": {"T1": {"level": 1, "verdict": "", "habits": []}},
        "habits": [],
    }
    (pd / "state.json").write_text(json.dumps(state), encoding="utf-8")
    write_attempts(tmp_path / "attempts", [att(0)])
    code = main(
        [
            "evidence",
            "--json",
            "--update-state",
            "--all",
            "--attempts-dir", str(tmp_path / "attempts"),
            "--reports-dir", str(tmp_path / "reports"),
            "--plan-dir", str(pd),
            "--data-dir", str(tmp_path / "scores"),
            "--today", "2026-11-05",
            "--utc",
        ]
    )
    assert code == 0
    written = json.loads((pd / "state.json").read_text(encoding="utf-8"))
    assert "gates" in written["nodes"]["T1"]
    errors, _ = plan.validate_state(written, tree)
    assert errors == []


B = "t1.b"
B_SCORE = "gen:t1-b"


def two_drill_tree():
    tree = tiny_tree()
    tree["nodes"][0]["drills"].append(
        {
            "id": B,
            "title": "B",
            "score": B_SCORE,
            "hands": "right",
            "mode": "live",
            "tempo": 100,
            "loop": False,
            "bars": None,
            "goal": "g",
            "kind": "generated",
        }
    )
    return tree


def b(day, **kw):
    return att(day, drill_id=B, score=B_SCORE, **kw)


def good_runs(make):
    return [make(0), make(0), make(1)]


def solid_of(make):
    return [make(0), make(1), make(2), make(2), make(2)]


def cold_of(make, n):
    return solid_of(make) + [make(12), make(24)][:n]


def two(attempts):
    return prog(attempts, tree=two_drill_tree())["T1"]


def test_one_drill_good_blocks_node():
    p = two(good_runs(att))
    g = p["gates"]["good"]
    assert g["met"] is False
    assert (g["drills_met"], g["drills_total"], g["missing"]) == (1, 2, [B])
    assert p["max_level"] == 1
    assert p["drills"]["t1.q"]["level"] == 2
    assert p["drills"][B]["level"] == 0


def test_all_drills_good():
    p = two(good_runs(att) + good_runs(b))
    assert p["gates"]["good"]["met"] is True
    assert p["gates"]["good"]["missing"] == []
    assert p["max_level"] == 2


def test_solid_needs_every_drill():
    p = two(solid_of(att) + good_runs(b))
    s = p["gates"]["solid"]
    assert s["met"] is False
    assert s["missing"] == [B]
    assert p["max_level"] == 2


def test_mastered_per_drill_cold_runs():
    p = two(cold_of(att, 2) + cold_of(b, 2))
    assert p["max_level"] == 4
    p = two(cold_of(att, 2) + cold_of(b, 1))
    assert p["max_level"] == 3
    assert p["gates"]["mastered"]["missing"] == [B]


def test_apply_to_state_caps_only_nodes_with_runs():
    state = {
        "version": 1,
        "nodes": {
            "T1": {"level": 4, "verdict": "", "habits": [], "rusty": True},
            "T2": {"level": 3, "verdict": "", "habits": []},
        },
        "habits": [],
    }
    new = gates.apply_to_state(state, prog([att(0)], state=state))
    assert new["nodes"]["T1"]["level"] == 1
    assert new["nodes"]["T1"]["rusty"] is False
    assert new["nodes"]["T2"]["level"] == 3


def test_node_line_shows_drill_counts():
    p = two(good_runs(att))
    assert "good not met (1 of 2 drills)" in trends._node_line("T1", p)
