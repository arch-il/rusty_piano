import copy
import shutil

from rusty_piano_coach import plan

REQUIRES = {"E1": [], "E2": ["E1"], "E3": ["E2"], "E4": ["E1"], "E5": ["E3", "E4"], "E6": ["E5"]}
TITLES = {
    "E1": "Pitch and direction by ear",
    "E2": "Intervals by ear",
    "E3": "Chord quality by ear",
    "E4": "Melodies and tunes by ear",
    "E5": "Progressions by ear",
    "E6": "Jazz basics: 7th chords and ii-V-I",
}
DRILLS = {
    "E1": ["echo-1", "echo-2", "echo-3", "updown-1", "updown-2"],
    "E2": ["interval-1", "interval-2", "interval-3", "interval-4"],
    "E3": ["chord-1", "chord-2", "chord-3"],
    "E4": ["echo-4", "echo-5", "tune-1", "tune-2", "tune-3"],
    "E5": ["bass-1", "bass-2", "bass-3"],
    "E6": ["chord-4", "bass-4"],
}
GATES = {"good": {"accuracy": 0.9}, "solid": {"accuracy": 0.95}, "mastered": {"accuracy": 0.95}}


def seed():
    return plan.load_json(plan.SEED_TREE)


def ear_nodes(tree):
    return [n for n in tree["nodes"] if n["track"] == "ear"]


def test_ear_track_entry():
    assert seed()["tracks"][-1] == {"id": "ear", "title": "Ear training"}


def test_ear_nodes():
    nodes = ear_nodes(seed())
    assert [n["id"] for n in nodes] == list(REQUIRES)
    for n in nodes:
        assert n["title"] == TITLES[n["id"]]
        assert n["requires"] == REQUIRES[n["id"]]
        assert n["measures"] == ["pitch"]
        assert n["gates"] == GATES
        assert [d["id"] for d in n["drills"]] == ["ear." + x for x in DRILLS[n["id"]]]
    assert sum(len(n["drills"]) for n in nodes) == 22


def test_ear_drills():
    for n in ear_nodes(seed()):
        for d in n["drills"]:
            assert d["kind"] == "generated"
            assert d["score"] == "ear:" + d["id"][4:]
            assert d["hands"] == "both"
            assert d["mode"] == "wait"
            assert d["tempo"] == 100
            assert d["loop"] is False
            assert d["bars"] is None
            assert d["goal"]


def test_seed_validates():
    assert plan.validate_tree(seed()) == []


def test_check_plan_ok(tmp_path):
    shutil.copyfile(plan.SEED_TREE, tmp_path / "tree.json")
    assert plan.check_plan(tmp_path)[0] == []


def test_ear_floor_only_for_ear():
    tree = copy.deepcopy(seed())
    e1 = next(n for n in tree["nodes"] if n["id"] == "E1")
    e1["gates"]["good"]["accuracy"] = 0.85
    assert any("below the floor 0.9" in e for e in plan.validate_tree(tree))
    tree = copy.deepcopy(seed())
    r1 = next(n for n in tree["nodes"] if n["id"] == "R1")
    r1.setdefault("gates", {}).setdefault("good", {})["accuracy"] = 0.9
    assert any("below the floor 0.95" in e for e in plan.validate_tree(tree))
