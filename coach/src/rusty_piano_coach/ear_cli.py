"""coach ear: append the seed tree's ear track (E1-E6) and its ear.* drills to the user's tree.json."""

import copy
import json
import os

from . import data_paths, plan

EAR_TRACK = "ear"


def add_ear_parser(sub) -> None:
    ep = sub.add_parser("ear", help="ear training: add the seed tree's ear track (E1-E6) to your tree.json")
    esub = ep.add_subparsers(dest="ear_command", required=True)
    ad = esub.add_parser(
        "add-drills",
        help="append the seed tree's ear track (E1-E6) and its ear.* drills to your tree.json; never removes or changes anything",
    )
    ad.add_argument("--plan-dir", default=None, help="plan folder (default: RUSTY_PIANO_DATA_DIR/plan or coach/data/plan)")


def merge_ear(tree, seed):
    new = copy.deepcopy(tree)
    added_track = False
    if not any(isinstance(t, dict) and t.get("id") == EAR_TRACK for t in new["tracks"]):
        seed_track = next(t for t in seed["tracks"] if t["id"] == EAR_TRACK)
        new["tracks"].append(copy.deepcopy(seed_track))
        added_track = True
    present = set(plan.drill_index(new))
    nodes = {n["id"]: n for n in new["nodes"]}
    added_nodes, added_drills, errors = [], [], []
    for seed_node in seed["nodes"]:
        if seed_node["track"] != EAR_TRACK:
            continue
        nid = seed_node["id"]
        if nid not in nodes:
            node = copy.deepcopy(seed_node)
            new["nodes"].append(node)
            nodes[nid] = node
            added_nodes.append(nid)
            added_drills += [d["id"] for d in node["drills"]]
            present.update(d["id"] for d in node["drills"])
        elif nodes[nid].get("track") != EAR_TRACK:
            errors.append(f"tree.json has a node {nid} that is not on the ear track")
        else:
            todo = [d for d in seed_node["drills"] if d["id"] not in present]
            nodes[nid]["drills"].extend(copy.deepcopy(todo))
            added_drills += [d["id"] for d in todo]
            present.update(d["id"] for d in todo)
    return new, added_track, added_nodes, added_drills, errors


def run_ear(args) -> int:
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
    if not isinstance(tree.get("tracks"), list):
        print("error: tree.json: no tracks list")
        return 1
    for n in tree["nodes"]:
        if isinstance(n, dict) and n.get("track") == EAR_TRACK and not isinstance(n.get("drills"), list):
            print(f"error: tree.json: node {n.get('id')} has no drills list")
            return 1
    new, added_track, added_nodes, added_drills, errors = merge_ear(tree, plan.load_json(plan.SEED_TREE))
    if errors:
        for e in errors:
            print(f"error: {e}")
        return 1
    if not added_track and not added_nodes and not added_drills:
        print("Ear drills are already in tree.json")
        return 0
    errors = plan.validate_tree(new)
    if errors:
        for e in errors:
            print(f"error: {e}")
        return 1
    tmp = tree_path.with_name(tree_path.name + ".tmp")
    tmp.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, tree_path)
    if added_nodes:
        print(f"Added the ear track: {', '.join(added_nodes)} ({len(added_drills)} drills)")
    elif added_drills:
        print(f"Added {len(added_drills)} ear drills: {', '.join(added_drills)}")
    if added_track and not added_nodes:
        print("Added the ear track entry")
    return 0
