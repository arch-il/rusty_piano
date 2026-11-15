import shutil
from pathlib import Path

import pytest

from rusty_piano_coach import data_paths, plan
from rusty_piano_coach.library import genx

NODE_IDS = [
    "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8",
    "T1", "T2", "T3", "T4", "T5", "T6", "T7",
    "K1", "K2", "K3", "K4", "K5", "K6", "K7",
    "C1", "C2", "C3", "C4",
    "D1", "D2", "D3",
    "P1",
    "S1", "S2", "S3", "S4", "S5", "S6",
]

PIECE_IDS = [
    "piece-first-steps", "piece-evening-song", "piece-ode-to-joy",
    "piece-twinkle", "piece-lightly-row", "piece-little-waltz",
]

EAR_IDS = ["E1", "E2", "E3", "E4", "E5", "E6"]

GEN_KEYS = {
    "r1-all-cs", "r1-two-black", "r1-three-black",
    "r2-steps", "r2-skips", *[f"r2-read-{i}" for i in range(1, 7)],
    "r3-steps", "r3-skips", *[f"r3-read-{i}" for i in range(1, 7)],
    "t1-quarters-rh", "t1-quarters-lh", "t1-quarters-cg",
    "t2-halves-rh", "t2-wholes-rh", "t2-mixed-rh", "t2-mixed-lh",
    "k1-c5-rh", "k1-c5-lh", "k1-c5-eighths-rh", "k1-c5-eighths-lh",
}


def seed():
    return plan.load_json(plan.SEED_TREE)


def all_drills(tree):
    return [d for n in tree["nodes"] for d in n["drills"]]


def test_seed_is_packaged_not_live(monkeypatch):
    monkeypatch.delenv("RUSTY_PIANO_DATA_DIR", raising=False)
    assert plan.SEED_TREE.resolve() != (data_paths.plan_dir() / "tree.json").resolve()
    package = Path(plan.__file__).resolve().parent
    assert package in plan.SEED_TREE.resolve().parents


def test_seed_ids_exist_in_live_tree(monkeypatch):
    # may be dropped once the user's tree diverges from the seed; piece nodes are new in the seed
    monkeypatch.delenv("RUSTY_PIANO_DATA_DIR", raising=False)
    live = data_paths.plan_dir() / "tree.json"
    if not live.exists():
        pytest.skip("no live tree")
    live_ids = {n["id"] for n in plan.load_json(live)["nodes"]}
    assert {n["id"] for n in seed()["nodes"] if n["track"] not in ("scales", "ear") and n.get("kind") != "piece"} <= live_ids


def test_seed_validates():
    assert plan.validate_tree(seed()) == []


def test_node_ids():
    assert [n["id"] for n in seed()["nodes"]] == NODE_IDS + PIECE_IDS + EAR_IDS


def test_roots_have_no_prerequisites():
    nodes = {n["id"]: n for n in seed()["nodes"]}
    for nid in ("R1", "T1", "K1"):
        assert nodes[nid]["requires"] == []


def test_drill_nodes():
    keys = {"gen:" + e.key for e in genx.all_exercises()}
    old = {"R1": 3, "R2": 8, "R3": 8, "T1": 3, "T2": 4, "K1": 4}
    for n in seed()["nodes"]:
        if n["track"] in ("scales", "ear"):
            continue
        assert n["drills"], n["id"]
        count = len([d for d in n["drills"] if d["score"] in keys])
        if n["id"] in old:
            assert len([d for d in n["drills"] if d["score"][4:] in GEN_KEYS]) == old[n["id"]], n["id"]
        elif n["id"] in PIECE_IDS:
            assert len(n["drills"]) == (2 if PIECE_IDS.index(n["id"]) < 3 else 3)
        else:
            assert 4 <= count <= 6, n["id"]
    with_sight = {n["id"] for n in seed()["nodes"] if any(d["id"].startswith("sr.") for d in n["drills"])}
    assert with_sight == {"R2", "R3", "R4", "R5", "R6", "R7", "R8"}


def test_drill_scores_and_keys():
    drills = [
        d for d in all_drills(seed())
        if not d["score"].startswith("scales:") and not d["id"].startswith("sr.") and not d["id"].startswith("ear.")
    ]
    assert all(d["score"].startswith("gen:") for d in drills)
    assert {d["score"][4:] for d in drills} == GEN_KEYS | {e.key for e in genx.all_exercises()}
    assert all(d["score"] == "ear:" + d["id"][4:] for d in all_drills(seed()) if d["id"].startswith("ear."))
    assert all(d["score"].startswith("sight:") for d in all_drills(seed()) if d["id"].startswith("sr."))


def test_check_plan_no_errors(tmp_path):
    shutil.copyfile(plan.SEED_TREE, tmp_path / "tree.json")
    errors, _warnings = plan.check_plan(tmp_path)
    assert errors == []


def test_drill_url():
    tree = seed()
    drill = plan.drill_index(tree)["r2.steps"]
    entry = drill[1] if isinstance(drill, tuple) else drill
    url = plan.drill_url(entry["score"], plan.drill_params(entry))
    assert url == "http://localhost:5173/#gen:r2-steps?drill=r2.steps&hands=R&tempo=100&mode=wait&loop=0"


def test_seed_cold_runs_per_drill():
    assert seed()["default_gates"]["mastered"]["cold_runs_per_drill"] == 2
    assert plan.validate_tree(seed()) == []
