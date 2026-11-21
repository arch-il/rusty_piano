from rusty_piano_coach import plan

from test_plan_migrate_skill_tree import fixture, live_state, live_tree, node_of, read_tree, seed, write

ALREADY_DIFFERENT_KEPT = set()

REWORDED = {
    "s2.a-natural-rh",
    "s2.a-natural-lh",
    "s2.a-harmonic-rh",
    "s2.a-harmonic-lh",
    "ear.updown-2",
    "t6.syncopation",
    "r4.middle-c",
    "r4.read-1",
    "r4.read-2",
    "r4.read-3",
}


def drills(tree):
    return {d["id"]: d for n in tree["nodes"] for d in n["drills"]}


def test_changed_set_covers_every_changed_drill():
    old = drills(fixture())
    new = drills(seed())
    for did in old.keys() & new.keys():
        if old[did] != new[did] and did not in ALREADY_DIFFERENT_KEPT:
            assert did in plan._REDESIGN_CHANGED, did


def test_reworded_ids_in_set():
    assert REWORDED <= plan._REDESIGN_CHANGED


def test_migration_brings_new_goals(tmp_path):
    tree = live_tree()
    drill = next(d for d in node_of(tree, "S2")["drills"] if d["id"] == "s2.a-melodic-rh")
    drill["goal"] = "my own goal"
    plan_dir = write(tmp_path, tree, live_state())
    assert plan.migrate_skill_tree(plan_dir) is True
    got = drills(read_tree(plan_dir))
    want = drills(seed())
    for did in REWORDED:
        if did in got:
            assert got[did] == want[did], did
    assert got["s2.a-melodic-rh"]["goal"] == "my own goal"
    assert plan.check_plan(plan_dir)[0] == []
