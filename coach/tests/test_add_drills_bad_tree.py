import json

import pytest

from rusty_piano_coach import cli
from test_ear_cli import stripped as ear_base
from test_sight_cli import stripped as sight_base

BASES = {"ear": ear_base, "sight": sight_base}


def write(folder, tree):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "tree.json").write_text(json.dumps(tree, indent=2), encoding="utf-8")


def other_node(tree):
    return next(
        n
        for n in tree["nodes"]
        if n["track"] != "ear" and not any(d["id"].startswith("sr.") for d in n["drills"])
    )


def no_drills(tree):
    del other_node(tree)["drills"]
    return tree


def drills_none(tree):
    other_node(tree)["drills"] = None
    return tree


def drills_str(tree):
    other_node(tree)["drills"] = "x"
    return tree


def drills_non_dict(tree):
    other_node(tree)["drills"] = [5]
    return tree


def no_id(tree):
    del other_node(tree)["id"]
    return tree


def sight_target_no_drills(tree):
    del next(n for n in tree["nodes"] if n["id"] == "R2")["drills"]
    return tree


def appended(value):
    def mutate(tree):
        tree["nodes"].append(value)
        return tree

    return mutate


MUTATIONS = [
    ("no-drills", no_drills),
    ("drills-none", drills_none),
    ("drills-str", drills_str),
    ("drills-non-dict", drills_non_dict),
    ("no-id", no_id),
    ("node-str", appended("oops")),
    ("node-none", appended(None)),
    ("node-int", appended(5)),
    ("node-list", appended([])),
]

CASES = [
    pytest.param(cmd, mutate, id=f"{cmd}-{name}")
    for cmd in ("ear", "sight")
    for name, mutate in MUTATIONS
] + [pytest.param("sight", sight_target_no_drills, id="sight-target-no-drills")]


@pytest.mark.parametrize("cmd, mutate", CASES)
def test_malformed_tree_is_a_clean_error(tmp_path, capsys, cmd, mutate):
    folder = tmp_path / "plan"
    write(folder, mutate(BASES[cmd]()))
    before = (folder / "tree.json").read_bytes()
    assert cli.main([cmd, "add-drills", "--plan-dir", str(folder)]) == 1
    captured = capsys.readouterr()
    assert captured.out.startswith("error: ")
    assert "Traceback" not in captured.out + captured.err
    assert (folder / "tree.json").read_bytes() == before
