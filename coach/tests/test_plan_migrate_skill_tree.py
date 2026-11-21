import argparse
import copy
import json
import os
import shutil
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from rusty_piano_coach import data_paths, plan, trends
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.server import handle_request

FIXTURE = Path(__file__).parent / "fixtures" / "seed_tree_before_redesign.json"

HISTORY = (
    "r1.all-cs r1.two-black r1.three-black r2.steps r2.skips r2.read-1 r2.read-2 r2.read-3 r2.read-4 r2.read-5 r2.read-6 "
    "r3.steps r3.skips r3.read-1 r3.read-2 r3.read-3 r3.read-4 r3.read-5 r3.read-6 sr.r2-treble sr.r3-bass "
    "t1.quarters-rh t1.quarters-lh t1.quarters-cg t2.halves-rh t2.wholes-rh t2.mixed-rh t2.mixed-lh t3.eighths-rh "
    "t3.eighths-lh t3.quarters-eighths t3.eighths-34 t3.hot-cross-buns k1.c5-rh k1.c5-lh k1.c5-eighths-rh "
    "k1.c5-eighths-lh k2.legato-rh k2.legato-lh k2.two-note-slurs k2.phrases k2.halves-lh k3.staccato-rh "
    "k3.staccato-lh c1.take-turns c1.melody-rh c1.melody-lh c1.hand-off c1.read-1 d1.loud-soft-rh d1.echo-rh "
    "d1.soft-loud-lh d1.echo-lh d1.three-levels s2.a-natural-rh s2.a-natural-lh s2.a-harmonic-rh s2.a-harmonic-lh "
    "s3.c-major-rh s3.c-major-lh ear.echo-1 ear.updown-1 piece.evening-song piece.evening-song-learn "
    "piece.first-steps piece.first-steps-learn"
).split()

PLAYING = ("score", "hands", "mode", "tempo", "loop", "bars", "ramp", "target")


def seed():
    return json.loads(plan.SEED_TREE.read_text(encoding="utf-8"))


def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def node_of(tree, nid):
    return next(n for n in tree["nodes"] if n["id"] == nid)


def dids(tree, nid):
    return [d["id"] for d in node_of(tree, nid)["drills"]]


def live_tree():
    tree = fixture()
    nodes = tree["nodes"]
    for src, new in (("R2", "R9"), ("R3", "R10")):
        node = node_of(tree, src)
        moved = [d for d in node["drills"] if d["id"][3:].startswith("read-") and int(d["id"][-1]) >= 4]
        node["drills"] = [d for d in node["drills"] if d not in moved]
        snippet = {"id": new, "kind": "skill", "track": "reading", "title": "More treble snippets", "requires": [src], "measures": ["pitch"], "drills": moved}
        nodes.insert(nodes.index(node) + 1, snippet)
    node_of(tree, "R4")["requires"] = ["R9", "R10"]
    del tree["default_gates"]["mastered"]["cold_runs_per_drill"]
    node_of(tree, "K2")["drills"].append(
        {"id": "k2.ode-legato", "kind": "segment", "title": "Ode legato", "score": "gen:piece-ode-to-joy", "hands": "right", "mode": "live", "tempo": 80, "loop": True, "bars": {"from": 1, "to": 4}, "goal": ""}
    )
    own = next(d for d in node_of(tree, "T3")["drills"] if d["id"] == "t3.eighths-rh")
    own["tempo"] = 80
    own["goal"] = "my own goal"
    mine = {
        "id": "piece-my-goal",
        "kind": "piece",
        "track": "pieces",
        "title": "My goal",
        "requires": ["C1"],
        "measures": ["pitch", "timing"],
        "score": "local:0123456789abcdef",
        "drills": [
            {"id": "piece.my-goal-rh", "kind": "segment", "title": "My goal", "score": "local:0123456789abcdef", "hands": "right", "mode": "wait", "tempo": 60, "loop": True, "bars": {"from": 1, "to": 4}, "goal": ""}
        ],
    }
    nodes.insert(nodes.index(node_of(tree, "piece-little-waltz")) + 1, mine)
    return tree


LEVELS = {"R1": 2, "R2": 2, "R3": 2, "R9": 2, "R10": 1, "T1": 2, "T2": 2, "T3": 2, "K1": 2, "K2": 2, "K3": 1, "C1": 2, "D1": 2, "S1": 2, "S2": 1, "S3": 1, "E1": 1, "piece-evening-song": 2, "piece-my-goal": 0}


def live_state(levels=LEVELS):
    return {
        "version": 1,
        "kind": "rusty_piano.state",
        "updated_at": "2026-11-17T00:00:00Z",
        "last_review": None,
        "plan_id": None,
        "nodes": {k: {"level": v, "verdict": "", "habits": []} for k, v in levels.items()},
        "habits": [{"id": "H1", "title": "x", "status": "improving", "nodes": ["R10", "T3"]}],
    }


def dump(obj):
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def write(base, tree, state=None, crlf=False):
    plan_dir = base / "plan"
    plan_dir.mkdir(parents=True)
    tree_bytes = dump(tree).encode()
    if crlf:
        tree_bytes = tree_bytes.replace(b"\n", b"\r\n")
    (plan_dir / "tree.json").write_bytes(tree_bytes)
    if state is not None:
        (plan_dir / "state.json").write_bytes(dump(state).encode())
    return plan_dir


def read_tree(plan_dir):
    return json.loads((plan_dir / "tree.json").read_bytes())


def read_state(plan_dir):
    return json.loads((plan_dir / "state.json").read_bytes())


def no_tmp(plan_dir):
    return not list(plan_dir.glob(".*.tmp")) and not list(plan_dir.glob("*.tmp"))


def test_first_call(tmp_path):
    live = live_tree()
    plan_dir = write(tmp_path, live, live_state())
    assert plan.migrate_skill_tree(plan_dir) is True
    tree = read_tree(plan_dir)
    assert plan.validate_tree(tree) == []
    assert plan.check_plan(plan_dir)[0] == []
    ids = [n["id"] for n in tree["nodes"]]
    expected = [n["id"] for n in seed()["nodes"]]
    expected.insert(expected.index("piece-little-waltz") + 1, "piece-my-goal")
    assert ids == expected
    assert "R9" not in ids and "R10" not in ids
    s = seed()
    assert dids(tree, "R2") == dids(s, "R2")
    assert dids(tree, "R3") == dids(s, "R3")
    assert node_of(tree, "R4")["requires"] == ["R2", "R3"]
    assert dids(tree, "K2")[-1] == "k2.ode-legato"
    t3 = next(d for d in node_of(tree, "T3")["drills"] if d["id"] == "t3.eighths-rh")
    assert t3["tempo"] == 80 and t3["goal"] == "my own goal"
    assert dids(tree, "piece-my-goal") == ["piece.my-goal-rh"]
    present = {d["id"] for n in tree["nodes"] for d in n["drills"]}
    assert not plan._REDESIGN_REMOVED & present
    seed_c3 = {d["id"]: d for d in node_of(s, "C3")["drills"]}
    for d in node_of(tree, "C3")["drills"]:
        if d["id"] in seed_c3:
            assert d == seed_c3[d["id"]]
    old = {d["id"]: d for n in live["nodes"] for d in n["drills"]}
    new = {d["id"]: d for n in tree["nodes"] for d in n["drills"]}
    for hid in HISTORY:
        assert hid in new and new[hid]["score"] == old[hid]["score"]
    for hid in old:
        if hid.startswith("s1."):
            assert new[hid]["score"] == old[hid]["score"]
    state = read_state(plan_dir)
    assert "R9" not in state["nodes"] and "R10" not in state["nodes"]
    expected_state = live_state()
    del expected_state["nodes"]["R9"], expected_state["nodes"]["R10"]
    expected_state["habits"][0]["nodes"] = ["R3", "T3"]
    assert state == expected_state
    assert state["nodes"]["R2"]["level"] == 2 and state["nodes"]["R3"]["level"] == 2
    assert tree["default_gates"] == live["default_gates"]
    assert plan.migrate_skill_tree(plan_dir) is False


def test_idempotent_bytes(tmp_path):
    plan_dir = write(tmp_path, live_tree(), live_state())
    assert plan.migrate_skill_tree(plan_dir) is True
    tree = (plan_dir / "tree.json").read_bytes()
    state = (plan_dir / "state.json").read_bytes()
    assert plan.migrate_skill_tree(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == tree
    assert (plan_dir / "state.json").read_bytes() == state
    assert no_tmp(plan_dir)


def test_no_r10_entry_still_merges(tmp_path):
    levels = {k: v for k, v in LEVELS.items() if k != "R10"}
    levels["R3"] = 2
    plan_dir = write(tmp_path, live_tree(), live_state(levels))
    assert plan.migrate_skill_tree(plan_dir) is True
    assert "R10" not in [n["id"] for n in read_tree(plan_dir)["nodes"]]


def test_no_state_file(tmp_path):
    plan_dir = write(tmp_path, live_tree())
    assert plan.migrate_skill_tree(plan_dir) is True
    tree = read_tree(plan_dir)
    assert "R9" not in [n["id"] for n in tree["nodes"]] and "R10" not in [n["id"] for n in tree["nodes"]]
    assert dids(tree, "R3") == dids(seed(), "R3")
    assert not (plan_dir / "state.json").exists()


def test_hand_edited_new_tree_with_snippet(tmp_path):
    tree = seed()
    node_of(tree, "R3")["drills"] = [d for d in node_of(tree, "R3")["drills"] if d["id"] not in ("r3.read-4", "r3.read-5", "r3.read-6")]
    moved = [d for d in seed()["nodes"][2]["drills"] if d["id"] in ("r3.read-4", "r3.read-5", "r3.read-6")]
    tree["nodes"].insert(3, {"id": "R10", "kind": "skill", "track": "reading", "title": "More", "requires": ["R3"], "measures": ["pitch"], "drills": moved})
    node_of(tree, "R4")["requires"] = ["R2", "R10"]
    state = live_state({"R3": 2, "R10": 1})
    plan_dir = write(tmp_path, tree, state)
    assert plan.migrate_skill_tree(plan_dir) is True
    new = read_tree(plan_dir)
    assert "R10" not in [n["id"] for n in new["nodes"]]
    assert dids(new, "R3") == dids(seed(), "R3")
    assert node_of(new, "R4")["requires"] == ["R2", "R3"]
    assert read_state(plan_dir)["habits"][0]["nodes"] == ["R3", "T3"]
    assert plan.migrate_skill_tree(plan_dir) is False


def test_state_follow_up(tmp_path):
    seed_bytes = dump(seed()).encode()
    plan_dir = write(tmp_path, seed(), live_state({"R3": 2, "R10": 1}))
    assert plan.migrate_skill_tree(plan_dir) is True
    assert (plan_dir / "tree.json").read_bytes() == seed_bytes
    state = read_state(plan_dir)
    assert "R10" not in state["nodes"] and state["habits"][0]["nodes"] == ["R3", "T3"]
    assert plan.migrate_skill_tree(plan_dir) is False


def test_keeps_crlf(tmp_path):
    plan_dir = write(tmp_path, live_tree(), live_state(), crlf=True)
    assert plan.migrate_skill_tree(plan_dir) is True
    data = (plan_dir / "tree.json").read_bytes()
    assert b"\r\n" in data and b"\n" not in data.replace(b"\r\n", b"")


def test_no_ear_track(tmp_path):
    tree = live_tree()
    tree["tracks"] = [t for t in tree["tracks"] if t["id"] != "ear"]
    tree["nodes"] = [n for n in tree["nodes"] if n.get("track") != "ear"]
    plan_dir = write(tmp_path, tree, live_state())
    assert plan.migrate_skill_tree(plan_dir) is True
    new = read_tree(plan_dir)
    assert not [n for n in new["nodes"] if n["track"] == "ear"]
    assert plan.validate_tree(new) == []


def test_no_sr_drills(tmp_path):
    tree = live_tree()
    for n in tree["nodes"]:
        n["drills"] = [d for d in n["drills"] if not d["id"].startswith("sr.")]
    plan_dir = write(tmp_path, tree, live_state())
    assert plan.migrate_skill_tree(plan_dir) is True
    assert not [d for n in read_tree(plan_dir)["nodes"] for d in n["drills"] if d["id"].startswith("sr.")]


def test_old_technique_untouched(tmp_path):
    tree = live_tree()
    k6 = node_of(tree, "K6")
    k6["drills"][0]["score"] = "gen:k7-broken-c-rh"
    k6["id"] = "K7"
    plan_dir = write(tmp_path, tree, live_state())
    tree_bytes = (plan_dir / "tree.json").read_bytes()
    assert plan.migrate_skill_tree(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == tree_bytes


def test_new_seed_untouched(tmp_path):
    plan_dir = write(tmp_path, seed(), live_state({"R3": 2}) | {"habits": []})
    tree_bytes = (plan_dir / "tree.json").read_bytes()
    state_bytes = (plan_dir / "state.json").read_bytes()
    assert plan.migrate_skill_tree(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == tree_bytes
    assert (plan_dir / "state.json").read_bytes() == state_bytes


def test_bad_state_json(tmp_path):
    plan_dir = write(tmp_path, live_tree())
    (plan_dir / "state.json").write_bytes(b"{not json")
    tree_bytes = (plan_dir / "tree.json").read_bytes()
    assert plan.migrate_skill_tree(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == tree_bytes
    assert no_tmp(plan_dir)


def test_other_files_untouched(tmp_path):
    plan_dir = write(tmp_path, live_tree(), live_state())
    (plan_dir / "journal").mkdir()
    (plan_dir / "pieces").mkdir()
    (plan_dir / "journal" / "2026-11.md").write_text("journal\n", encoding="utf-8")
    (plan_dir / "today.md").write_text(plan.drill_url("gen:r3-read-5", {}) + "\n", encoding="utf-8")
    (plan_dir / "pieces" / "x.md").write_text("notes\n", encoding="utf-8")
    others = {p: p.read_bytes() for p in (plan_dir / "journal" / "2026-11.md", plan_dir / "today.md", plan_dir / "pieces" / "x.md")}
    assert plan.migrate_skill_tree(plan_dir) is True
    for p, data in others.items():
        assert p.read_bytes() == data


def test_plan_check_prints_fixed(tmp_path, capsys):
    plan_dir = write(tmp_path, live_tree(), live_state())
    args = argparse.Namespace(plan_command="check", plan_dir=str(plan_dir))
    assert plan.run_plan(args) == 0
    out = capsys.readouterr().out
    assert out.splitlines().count(f"fixed: tree.json, state.json: {plan.SKILL_TREE_FIX}") == 1
    assert plan.run_plan(args) == 0
    assert "fixed:" not in capsys.readouterr().out


def test_server_fixes_plan(tmp_path):
    plan_dir = write(tmp_path, live_tree(), live_state())
    r = handle_request(tmp_path / "lib", "/api/plan", "GET", {"Host": "127.0.0.1:8765"}, Jobs(), plan_dir=plan_dir)
    assert r.status == 200
    ids = [n["id"] for n in json.loads(r.body)["tree"]["nodes"]]
    assert "M1" in ids and "R9" not in ids


def test_build_evidence_warns(tmp_path):
    plan_dir = write(tmp_path, live_tree(), live_state())
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
    assert f"tree.json, state.json: {plan.SKILL_TREE_FIX} (one-off fix)" in ev["warnings"]


def test_redesign_changed_set():
    old = {d["id"]: d for n in fixture()["nodes"] for d in n["drills"]}
    new = {d["id"]: d for n in seed()["nodes"] for d in n["drills"]}
    differ = {i for i in old if i in new and any(old[i].get(k) != new[i].get(k) for k in PLAYING)}
    assert differ == {
        "c3.octaves", "c3.contrary", "c3.tenths-halves", "c3.tenths-quarters", "c3.melody-bass",
        "c4.quarters-halves", "c4.eighths-quarters", "c4.halves-quarters", "c4.dotted-tune",
    }
    for i in plan._REDESIGN_CHANGED:
        assert i in old and i in new


def test_live_plan_copy(tmp_path, monkeypatch):
    if os.environ.get("COACH_LIVE_PLAN_TEST") != "1":
        pytest.skip("set COACH_LIVE_PLAN_TEST=1 to run against a copy of the live plan")
    monkeypatch.delenv("RUSTY_PIANO_DATA_DIR", raising=False)
    live = data_paths.plan_dir()
    if not (live / "tree.json").exists():
        pytest.skip("no live plan")
    copy_dir = tmp_path / "plan"
    copy_dir.mkdir()
    for name in ("tree.json", "state.json", "today.md"):
        if (live / name).exists():
            shutil.copyfile(live / name, copy_dir / name)
    before_tree = read_tree(copy_dir)
    before_state = read_state(copy_dir) if (copy_dir / "state.json").exists() else None
    plan.migrate_tree(copy_dir)
    plan.migrate_technique(copy_dir)
    plan.migrate_skill_tree(copy_dir)
    assert plan.check_plan(copy_dir)[0] == []
    tree = read_tree(copy_dir)
    ids = [n["id"] for n in tree["nodes"]]
    assert "M1" in ids and "R9" not in ids
    if before_state is not None:
        after = read_state(copy_dir)
        for nid, entry in before_state["nodes"].items():
            if nid not in ("R9", "R10"):
                assert after["nodes"][nid]["level"] == entry["level"]
    old = {d["id"]: d for n in before_tree["nodes"] for d in n["drills"]}
    new = {d["id"]: d for n in tree["nodes"] for d in n["drills"]}
    for i, d in old.items():
        if i in new and i not in plan._REDESIGN_CHANGED:
            assert new[i] == d
