"""coach sight: append the seed tree's sight-reading drills (sr.*) to the user's tree.json."""

import copy
import json
import os

from . import data_paths, plan

SIGHT_PREFIX = "sr."


def add_sight_parser(sub) -> None:
    sp = sub.add_parser("sight", help="sight-reading drills: add the seed tree's sr.* drills to your tree.json")
    ssub = sp.add_subparsers(dest="sight_command", required=True)
    ad = ssub.add_parser(
        "add-drills",
        help="append the seed tree's sight-reading drills (sr.*) to your tree.json; never removes or changes anything",
    )
    ad.add_argument("--plan-dir", default=None, help="plan folder (default: RUSTY_PIANO_DATA_DIR/plan or coach/data/plan)")


def merge_sight_drills(tree, seed):
    new = copy.deepcopy(tree)
    present = set(plan.drill_index(new))
    nodes = {n["id"]: n for n in new["nodes"]}
    added, missing = [], []
    for seed_node in seed["nodes"]:
        todo = [
            d
            for d in seed_node["drills"]
            if d["id"].startswith(SIGHT_PREFIX) and d["id"] not in present
        ]
        if not todo:
            continue
        if seed_node["id"] not in nodes:
            missing.append(seed_node["id"])
            continue
        nodes[seed_node["id"]]["drills"].extend(copy.deepcopy(todo))
        added += [d["id"] for d in todo]
        present.update(d["id"] for d in todo)
    return new, added, missing


def run_sight(args) -> int:
    plan_dir = data_paths.plan_dir(args.plan_dir)
    tree_path = plan_dir / plan.TREE_FILE
    if not tree_path.exists():
        print("error: tree.json: missing; run coach plan init")
        return 1
    try:
        tree = plan.load_json(tree_path)
    except ValueError as e:
        print(f"error: {e}")
        return 1
    if not (isinstance(tree, dict) and isinstance(tree.get("nodes"), list)):
        print("error: tree.json: no nodes list")
        return 1
    new, added, missing = merge_sight_drills(tree, plan.load_json(plan.SEED_TREE))
    for nid in missing:
        print(f"warning: no node {nid} in tree.json")
    if not added:
        if not missing:
            print("Sight-reading drills are already in tree.json")
        return 0
    errors = plan.validate_tree(new)
    if errors:
        for e in errors:
            print(f"error: {e}")
        return 1
    tmp = tree_path.with_name(tree_path.name + ".tmp")
    tmp.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, tree_path)
    print(f"Added {len(added)} sight-reading drills: {', '.join(added)}")
    return 0
