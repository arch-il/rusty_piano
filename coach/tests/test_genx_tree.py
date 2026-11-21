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
    later = ["R4", "R5", "R6", "R7", "R11", "R12", "R13", "R14",
             "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11",
             "K2", "K3", "K4", "K5", "K6", "K8", "K9", "K10", "K11",
             "C1", "C2", "C3", "C4", "C5", "C6", "D1", "D2", "D3", "D4", "P1", "P2",
             "M1", "M2", "M3", "M4", "M5"]
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
            assert ids == [base + "-rh", base + "-lh", base + "-together", base]
        assert n["drills"][-1]["hands"] == "both"
        assert n["drills"][-1]["mode"] == "live"
    assert plan.validate_tree(seed) == []


def test_live_plan_untouched(monkeypatch):
    monkeypatch.delenv("RUSTY_PIANO_DATA_DIR", raising=False)
    assert data_paths.plan_dir().resolve() != plan.SEED_TREE.parent.resolve()


def test_refresh_drops_stale():
    t = copy.deepcopy(seed)
    node = next(n for n in t["nodes"] if n["id"] == "R8")
    node["drills"].append({"id": "r8.stale", "kind": "generated", "title": "x", "score": "gen:r8-sight-1",
                           "hands": "right", "mode": "wait", "tempo": 100, "loop": False, "bars": None, "goal": "x"})
    out = seedtree.extend(t)
    r8 = next(n for n in out["nodes"] if n["id"] == "R8")
    assert all(d["score"] != "gen:r8-sight-1" for d in r8["drills"])
    assert out == seed


def test_refresh_keeps_catalogue():
    out = seedtree.extend(copy.deepcopy(seed))
    scores = {d["score"] for n in out["nodes"] for d in n["drills"]}
    assert "gen:r2-read-1" in scores
    assert "gen:r1-all-cs" in scores


def test_refresh_updates_mode():
    t = copy.deepcopy(seed)
    c3 = next(n for n in t["nodes"] if n["id"] == "C3")
    changed = c3["drills"][-1]
    original = changed["mode"]
    changed["mode"] = "wait" if original == "live" else "live"
    ex = next(e for e in genx.all_exercises() if e.node == "C3" and "gen:" + e.key == changed["score"] and genx.drill(e)["id"] == changed["id"])
    out = seedtree.extend(t)
    back = next(n for n in out["nodes"] if n["id"] == "C3")
    assert next(d for d in back["drills"] if d["id"] == changed["id"])["mode"] == ex.mode


def _norm(text):
    words = {"pp", "p", "mp", "mf", "f", "ff", "cresc", "dim", "end", "ped", "pedup", "pedchange"}
    bars = []
    for chunk in text.split("|"):
        toks = [t for t in chunk.split() if t not in words]
        bars.append(" ".join(toks))
    return bars


def _held(bars):
    toks = [t for b in bars for t in b.split()]
    return all(t.startswith("r") or t.endswith(":w") for t in toks)


def _notes(bars):
    return len([t for b in bars for t in b.split() if not t.startswith("r")])


SHARED_HEADS = {
    "C4 D4 E4 F4 | G4 F4 E4 D4",
    "C3 D3 E3 F3 | G3 F3 E3 D3",
    "C4 D4 E4 F4 | G4:h r:h",
    "C3 D3 E3 F3 | G3:w",
}


def test_no_duplicate_material():
    full = {}
    heads = {}
    for ex in genx.all_exercises():
        for hand, text in (("rh", ex.rh), ("lh", ex.lh)):
            if not text.strip():
                continue
            bars = _norm(text)
            if not _held(bars) and _notes(bars) >= 4:
                full.setdefault(" | ".join(bars), []).append(f"{ex.key}/{hand}")
            head = " | ".join(bars[:2])
            if not _held(bars[:2]) and head not in SHARED_HEADS:
                heads.setdefault(head, set()).add(ex.key)
    allowed = {"c3-octaves/rh", "c3-contrary/rh"}
    for text, owners in full.items():
        if len(owners) > 1:
            assert set(owners) == allowed, (text, owners)
    for head, owners in heads.items():
        assert len(owners) == 1, (head, owners)
