import copy
import json

from rusty_piano_coach import cli, plan


def seed():
    return plan.load_json(plan.SEED_TREE)


def ear_ids(tree):
    return [d["id"] for n in tree["nodes"] if n["track"] == "ear" for d in n["drills"]]


def stripped():
    tree = seed()
    tree["tracks"] = [t for t in tree["tracks"] if t["id"] != "ear"]
    tree["nodes"] = [n for n in tree["nodes"] if n["track"] != "ear"]
    return tree


def write(folder, tree):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "tree.json").write_text(json.dumps(tree, indent=2), encoding="utf-8")


def test_add_drills_appends_track_nodes_and_drills(tmp_path, capsys):
    write(tmp_path, stripped())
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    assert "Added the ear track: E1, E2, E3, E4, E5, E6 (22 drills)" in capsys.readouterr().out
    tree = plan.load_json(tmp_path / "tree.json")
    assert plan.validate_tree(tree) == []
    assert tree["tracks"][-1] == {"id": "ear", "title": "Ear training"}
    assert [n["id"] for n in tree["nodes"][-6:]] == ["E1", "E2", "E3", "E4", "E5", "E6"]
    assert ear_ids(tree) == ear_ids(seed())
    assert len(ear_ids(tree)) == 22
    expected = seed()
    assert [n for n in tree["nodes"] if n["track"] != "ear"] == [n for n in expected["nodes"] if n["track"] != "ear"]


def test_second_run_adds_nothing(tmp_path, capsys):
    write(tmp_path, stripped())
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    before = (tmp_path / "tree.json").read_bytes()
    capsys.readouterr()
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    assert "already" in capsys.readouterr().out
    assert (tmp_path / "tree.json").read_bytes() == before


def test_missing_drills_are_added_to_an_existing_ear_node(tmp_path, capsys):
    tree = stripped()
    e1 = copy.deepcopy(next(n for n in seed()["nodes"] if n["id"] == "E1"))
    e1["drills"] = [e1["drills"][0]]
    tree["tracks"].append({"id": "ear", "title": "Ear training"})
    tree["nodes"].append(e1)
    write(tmp_path, tree)
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    result = plan.load_json(tmp_path / "tree.json")
    assert plan.validate_tree(result) == []
    assert ear_ids(result) == ear_ids(seed())
    got = next(n for n in result["nodes"] if n["id"] == "E1")
    assert [d["id"] for d in got["drills"]] == [d["id"] for d in next(n for n in seed()["nodes"] if n["id"] == "E1")["drills"]]


def test_node_on_another_track_is_an_error(tmp_path, capsys):
    tree = seed()
    next(n for n in tree["nodes"] if n["id"] == "E1")["track"] = "reading"
    write(tmp_path, tree)
    before = (tmp_path / "tree.json").read_bytes()
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 1
    assert "error: tree.json has a node E1 that is not on the ear track" in capsys.readouterr().out
    assert (tmp_path / "tree.json").read_bytes() == before


def test_missing_tree_is_an_error(tmp_path, capsys):
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 1
    assert "error: tree.json: missing; run coach plan init" in capsys.readouterr().out


def test_broken_json_is_an_error(tmp_path, capsys):
    (tmp_path / "tree.json").write_text("{", encoding="utf-8")
    before = (tmp_path / "tree.json").read_bytes()
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 1
    assert "error: tree.json is not valid JSON" in capsys.readouterr().out
    assert (tmp_path / "tree.json").read_bytes() == before


def test_tree_without_nodes_list_is_an_error(tmp_path, capsys):
    (tmp_path / "tree.json").write_text('{"version": 1}', encoding="utf-8")
    before = (tmp_path / "tree.json").read_bytes()
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 1
    assert "error: tree.json: no nodes list" in capsys.readouterr().out
    assert (tmp_path / "tree.json").read_bytes() == before


def test_ear_nodes_without_track_entry_get_the_entry(tmp_path, capsys):
    tree = seed()
    tree["tracks"] = [t for t in tree["tracks"] if t["id"] != "ear"]
    write(tmp_path, tree)
    assert cli.main(["ear", "add-drills", "--plan-dir", str(tmp_path)]) == 0
    assert "Added the ear track entry" in capsys.readouterr().out
    result = plan.load_json(tmp_path / "tree.json")
    assert plan.validate_tree(result) == []
    assert result["tracks"][-1] == {"id": "ear", "title": "Ear training"}


def _bad_drills(tree, value):
    node = next(n for n in tree["nodes"] if n["id"] == "E1")
    if value == "missing":
        del node["drills"]
    else:
        node["drills"] = value


def test_malformed_ear_node_drills_is_a_clean_error(tmp_path, capsys):
    for i, value in enumerate(["missing", None, "x", {"a": 1}]):
        folder = tmp_path / str(i)
        tree = seed()
        _bad_drills(tree, value)
        write(folder, tree)
        before = (folder / "tree.json").read_bytes()
        assert cli.main(["ear", "add-drills", "--plan-dir", str(folder)]) == 1
        assert capsys.readouterr().out.startswith("error: ")
        assert (folder / "tree.json").read_bytes() == before


def test_malformed_tracks_is_a_clean_error(tmp_path, capsys):
    for i, value in enumerate(["missing", None, {"id": "ear"}, "x"]):
        folder = tmp_path / str(i)
        tree = seed()
        if value == "missing":
            del tree["tracks"]
        else:
            tree["tracks"] = value
        write(folder, tree)
        before = (folder / "tree.json").read_bytes()
        assert cli.main(["ear", "add-drills", "--plan-dir", str(folder)]) == 1
        assert capsys.readouterr().out.startswith("error: ")
        assert (folder / "tree.json").read_bytes() == before
