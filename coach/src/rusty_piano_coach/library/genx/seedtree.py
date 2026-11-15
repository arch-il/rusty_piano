import copy
import json
import sys

from rusty_piano_coach import plan

from . import all_exercises, all_piece_nodes
from .core import drill

LEARN_GOAL = "Learn the notes slowly in wait mode, then play the whole piece in live mode."


def piece_node(meta, ex):
    base = ex.key.replace("-", ".", 1)
    if ex.rh and ex.lh:
        drills = [
            drill(ex, id=base + "-rh", title=meta["title"] + ", right hand alone",
                  hands="right", mode="wait", goal=LEARN_GOAL),
            drill(ex, id=base + "-lh", title=meta["title"] + ", left hand alone",
                  hands="left", mode="wait", goal=LEARN_GOAL),
            drill(ex),
        ]
    else:
        drills = [
            drill(ex, id=base + "-learn", title=meta["title"] + ", learn slowly",
                  mode="wait", goal=LEARN_GOAL),
            drill(ex),
        ]
    return {
        "id": meta["id"],
        "kind": "piece",
        "track": "pieces",
        "title": meta["title"],
        "summary": meta["summary"],
        "requires": list(meta["requires"]),
        "measures": list(meta["measures"]),
        "score": "gen:" + ex.key,
        "drills": drills,
    }


def extend(tree):
    out = copy.deepcopy(tree)
    nodes = {n["id"]: n for n in out["nodes"]}
    exercises = all_exercises()
    for ex in exercises:
        if ex.node.startswith("piece-"):
            continue
        if ex.node not in nodes:
            raise ValueError(f"exercise {ex.key} names unknown node {ex.node}")
        d = drill(ex)
        node = nodes[ex.node]
        if not any(x["id"] == d["id"] for x in node["drills"]):
            node["drills"].append(d)
    by_key = {ex.key: ex for ex in exercises}
    for meta in all_piece_nodes():
        if meta["id"] not in nodes:
            node = piece_node(meta, by_key[meta["id"]])
            out["nodes"].append(node)
            nodes[node["id"]] = node
    return out


def render(tree):
    return json.dumps(tree, indent=2, ensure_ascii=False) + "\n"


def main(argv=None):
    argv = argv or []
    tree = plan.load_json(plan.SEED_TREE)
    out = extend(tree)
    text = render(out)
    if "--print" in argv:
        print(text)
        return
    plan.SEED_TREE.write_text(text, encoding="utf-8")
    n_drills = sum(len(n["drills"]) for n in out["nodes"])
    print(f"seed tree: {len(out['nodes'])} nodes, {n_drills} drills")


if __name__ == "__main__":
    main(sys.argv[1:])
