import copy
import shutil

from rusty_piano_coach import plan
from rusty_piano_coach.library.scales import BY_KEY

SCALE_NODES = ["S1", "S2", "S3", "S4", "S5", "S6"]
DRILL_COUNTS = [8, 6, 8, 8, 5, 6]
REQUIRES = {
    "S1": [],
    "S2": ["S1"],
    "S3": ["S1"],
    "S4": ["S2", "S3"],
    "S5": ["S4"],
    "S6": ["S5"],
}
HANDS = {"rh": "right", "lh": "left", "ht": "both"}


def seed():
    return plan.load_json(plan.SEED_TREE)


def scale_nodes(tree):
    return [n for n in tree["nodes"] if n["track"] == "scales"]


def test_scales_track_before_ear():
    tracks = seed()["tracks"]
    assert [t["id"] for t in tracks[-2:]] == ["scales", "ear"]
    assert tracks[-2] == {"id": "scales", "title": "Scales and arpeggios"}


def test_scale_nodes():
    tree = seed()
    nodes = scale_nodes(tree)
    assert [n["id"] for n in nodes] == SCALE_NODES
    skills = [n for n in tree["nodes"] if n.get("kind") != "piece" and n["track"] != "ear"]
    assert [n["id"] for n in skills[-6:]] == SCALE_NODES
    assert {n["id"]: n["requires"] for n in nodes} == REQUIRES
    assert [len(n["drills"]) for n in nodes] == DRILL_COUNTS
    assert sum(DRILL_COUNTS) == 41


def test_scale_drills_match_catalogue():
    ids = []
    for node in scale_nodes(seed()):
        for drill in node["drills"]:
            ids.append(drill["id"])
            assert drill["score"].startswith("scales:")
            key = drill["score"][len("scales:"):]
            assert key in BY_KEY
            assert BY_KEY[key].node == node["id"]
            assert drill["hands"] == HANDS[key.rsplit("-", 1)[1]]
            assert drill["mode"] == "live"
            assert drill["kind"] == "generated"
            assert 20 <= drill["tempo"] <= 150
            assert drill["id"].startswith(node["id"].lower() + ".")
    assert len(set(ids)) == len(ids)


def test_scale_gates():
    tree = seed()
    for node in scale_nodes(tree):
        merged = plan.merged_gates(tree, node)
        for level in plan.LEVELS:
            assert merged[level]["evenness"] == 0.8
    assert plan.validate_tree(tree) == []


def test_evenness_floor_and_range():
    tree = copy.deepcopy(seed())
    s1 = next(n for n in tree["nodes"] if n["id"] == "S1")
    s1["gates"]["good"]["evenness"] = 0.7
    errors = plan.validate_tree(tree)
    assert any("evenness" in e and "below the floor 0.8" in e for e in errors)
    s1["gates"]["good"]["evenness"] = 1.5
    errors = plan.validate_tree(tree)
    assert any("evenness" in e for e in errors)


def test_check_plan_ok(tmp_path):
    shutil.copyfile(plan.SEED_TREE, tmp_path / "tree.json")
    assert plan.check_plan(tmp_path)[0] == []
