import copy

from rusty_piano_coach import data_paths, plan
from rusty_piano_coach.library import gen, genx
from rusty_piano_coach.library.genx import seedtree
from test_plan_seed import NODE_IDS

seed = plan.load_json(plan.SEED_TREE)

ONE_HAND = {"piece-first-steps", "piece-evening-song", "piece-ode-to-joy"}


def strip(tree):
    t = copy.deepcopy(tree)
    piece_ids = {p["id"] for p in genx.all_piece_nodes()}
    scores = {"gen:" + e.key for e in genx.all_exercises()}
    t["nodes"] = [n for n in t["nodes"] if n["id"] not in piece_ids and n.get("track") != "ear"]
    for n in t["nodes"]:
        n["drills"] = [d for d in n["drills"] if d["score"] not in scores]
    return t


def genx_count(node):
    keys = {"gen:" + e.key for e in genx.all_exercises()}
    return len([d for d in node["drills"] if d["score"] in keys])


def test_up_to_date():
    assert seedtree.extend(seed) == seed
    assert seedtree.render(seed) == plan.SEED_TREE.read_text(encoding="utf-8")


def test_append_only():
    s = strip(seed)
    assert [n["id"] for n in s["nodes"]] == NODE_IDS
    with_drills = [n for n in s["nodes"] if n["track"] != "scales" and any(not d["id"].startswith("sr.") for d in n["drills"])]
    assert {n["id"] for n in with_drills} == {"R1", "R2", "R3", "T1", "T2", "K1"}
    drills = [d for n in with_drills for d in n["drills"] if not d["id"].startswith("sr.")]
    assert len(drills) == 30
    old_keys = {"gen:" + e.key for e in gen.CATALOGUE}
    assert all(d["score"] in old_keys for d in drills)
    no_ear = copy.deepcopy(seed)
    no_ear["nodes"] = [n for n in no_ear["nodes"] if n.get("track") != "ear"]
    assert seedtree.extend(s) == no_ear


def test_scores_exist():
    keys = {"gen:" + e.key for e in gen.all_exercises()}
    used = {d["score"] for n in seed["nodes"] for d in n["drills"] if d["score"].startswith("gen:")}
    used |= {n["score"] for n in seed["nodes"] if n.get("score")}
    assert used <= keys
    assert keys <= used


def test_later_nodes():
    later = ["R4", "R5", "R6", "R7", "R8", "T3", "T4", "T5", "T6", "T7",
             "K2", "K3", "K4", "K5", "K6", "K7", "C1", "C2", "C3", "C4",
             "D1", "D2", "D3", "P1"]
    nodes = {n["id"]: n for n in seed["nodes"]}
    for nid in later:
        assert 4 <= genx_count(nodes[nid]) <= 6, nid


def test_pieces():
    metas = genx.all_piece_nodes()
    pieces = [n for n in seed["nodes"] if n.get("kind") == "piece"]
    assert [n["id"] for n in pieces] == [m["id"] for m in metas]
    for n in pieces:
        assert n["kind"] == "piece"
        assert n["track"] == "pieces"
        assert n["score"] == "gen:" + n["id"]
        base = n["id"].replace("-", ".", 1)
        ids = [d["id"] for d in n["drills"]]
        if n["id"] in ONE_HAND:
            assert ids == [base + "-learn", base]
        else:
            assert ids == [base + "-rh", base + "-lh", base]
        assert n["drills"][-1]["hands"] == "both"
        assert n["drills"][-1]["mode"] == "live"
    assert plan.validate_tree(seed) == []


def test_live_plan_untouched(monkeypatch):
    monkeypatch.delenv("RUSTY_PIANO_DATA_DIR", raising=False)
    assert data_paths.plan_dir().resolve() != plan.SEED_TREE.parent.resolve()
