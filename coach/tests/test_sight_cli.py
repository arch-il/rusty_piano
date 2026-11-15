import copy
import json

from rusty_piano_coach import cli, plan


def seed():
    return plan.load_json(plan.SEED_TREE)


def stripped():
    tree = seed()
    for node in tree["nodes"]:
        node["drills"] = [d for d in node["drills"] if not d["id"].startswith("sr.")]
    r2 = next(n for n in tree["nodes"] if n["id"] == "R2")
    mine = copy.deepcopy(r2["drills"][0])
    mine["id"] = "r2.mine"
    mine["score"] = "gen:r2-mine"
    r2["drills"].insert(0, mine)
    return tree


def write(folder, tree):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "tree.json").write_text(json.dumps(tree, indent=2), encoding="utf-8")


def sr_ids(tree):
    return [d["id"] for n in tree["nodes"] for d in n["drills"] if d["id"].startswith("sr.")]


def test_add_drills_appends_last_and_keeps_user_drills(tmp_path, capsys):
    write(tmp_path, stripped())
    assert cli.main(["sight", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    assert "Added 9 sight-reading drills" in capsys.readouterr().out
    tree = plan.load_json(tmp_path / "tree.json")
    assert plan.validate_tree(tree) == []
    assert sr_ids(tree) == sr_ids(seed())
    assert len(sr_ids(tree)) == 9
    for node in tree["nodes"]:
        sight = [d["id"] for d in node["drills"] if d["id"].startswith("sr.")]
        if sight:
            assert [d["id"] for d in node["drills"][-len(sight) :]] == sight
    r2 = next(n for n in tree["nodes"] if n["id"] == "R2")
    assert r2["drills"][0]["id"] == "r2.mine"


def test_second_run_adds_nothing(tmp_path, capsys):
    write(tmp_path, stripped())
    assert cli.main(["sight", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    before = (tmp_path / "tree.json").read_bytes()
    capsys.readouterr()
    assert cli.main(["sight", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    assert "Sight-reading drills are already in tree.json" in capsys.readouterr().out
    assert (tmp_path / "tree.json").read_bytes() == before


def test_missing_tree_is_an_error(tmp_path, capsys):
    assert cli.main(["sight", "add-drills", "--plan-dir", str(tmp_path)]) == 1
    assert "error: tree.json: missing; run coach plan init" in capsys.readouterr().out


def test_tree_without_nodes_list_is_an_error(tmp_path, capsys):
    (tmp_path / "tree.json").write_text('{"version": 1}', encoding="utf-8")
    before = (tmp_path / "tree.json").read_bytes()
    assert cli.main(["sight", "add-drills", "--plan-dir", str(tmp_path)]) == 1
    assert "error: tree.json" in capsys.readouterr().out
    assert (tmp_path / "tree.json").read_bytes() == before


def test_tree_that_is_a_json_list_is_an_error(tmp_path, capsys):
    (tmp_path / "tree.json").write_text("[]", encoding="utf-8")
    before = (tmp_path / "tree.json").read_bytes()
    assert cli.main(["sight", "add-drills", "--plan-dir", str(tmp_path)]) == 1
    assert "error: tree.json" in capsys.readouterr().out
    assert (tmp_path / "tree.json").read_bytes() == before


def test_tree_without_r5_adds_the_others_and_warns(tmp_path, capsys):
    tree = stripped()
    tree["nodes"] = [n for n in tree["nodes"] if n["id"] != "R5"]
    for node in tree["nodes"]:
        node["requires"] = ["R4" if r == "R5" else r for r in node["requires"]]
    write(tmp_path, tree)
    assert cli.main(["sight", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    assert "warning: no node R5 in tree.json" in out
    result = plan.load_json(tmp_path / "tree.json")
    assert plan.validate_tree(result) == []
    assert sr_ids(result) == [i for i in sr_ids(seed()) if i != "sr.r5-intervals"]


def test_tree_without_any_sight_node_warns_and_adds_nothing(tmp_path, capsys):
    tree = stripped()
    gone = {f"R{i}" for i in range(2, 9)}
    tree["nodes"] = [n for n in tree["nodes"] if n["id"] not in gone]
    for node in tree["nodes"]:
        node["requires"] = [r for r in node["requires"] if r not in gone]
    write(tmp_path, tree)
    before = (tmp_path / "tree.json").read_bytes()
    assert cli.main(["sight", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    out = capsys.readouterr().out
    for nid in sorted(gone):
        assert f"warning: no node {nid} in tree.json" in out
    assert "already in tree.json" not in out
    assert (tmp_path / "tree.json").read_bytes() == before
