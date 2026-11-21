"""The practice plan: tree.json (skills and drills), state.json (levels and habits), today.md (the day's links)."""

import argparse
import copy
import json
import os
import re
import shutil
import tempfile
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from . import data_paths

TREE_FILE = "tree.json"
STATE_FILE = "state.json"
TODAY_FILE = "today.md"
SCHEMA_DIR = Path(__file__).parent / "schemas"
SEED_TREE = Path(__file__).resolve().parent / "seed" / "tree.json"

GATE_FLOORS = {
    "good": {"accuracy": 0.95, "timing": 0.6, "tempo_ratio": 0.8, "clean_runs": 3, "days": 2},
    "solid": {"accuracy": 0.98, "timing": 0.8, "tempo_ratio": 1.0, "clean_in_window": 5, "days": 3},
    "mastered": {"accuracy": 0.98, "timing": 0.8, "tempo_ratio": 1.0, "away_days": 7, "cold_runs": 3, "cold_runs_per_drill": 2, "materials": 2},
}
# Ear accuracy is the first-try share; the user asked for 90% first try.
TRACK_GATE_FLOORS = {"ear": {"good": {"accuracy": 0.9}, "solid": {"accuracy": 0.95}, "mastered": {"accuracy": 0.95}}}
EVENNESS_FLOOR = 0.8
LEVELS = ("good", "solid", "mastered")

SUPPORTED_KEYWORDS = {
    "$schema",
    "$id",
    "title",
    "description",
    "$defs",
    "$ref",
    "type",
    "enum",
    "const",
    "required",
    "properties",
    "additionalProperties",
    "propertyNames",
    "items",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "pattern",
}

NODE_ID_RE = r"([A-Z][0-9]{1,2}|piece-[a-z0-9-]+)"
DRILL_RE = re.compile(r"[a-z][a-z0-9]*([.][a-z0-9-]+)+")
PLAN_RE = re.compile(r"[A-Za-z0-9._-]{1,40}")
TAG_RE = re.compile(r"[a-z0-9-]{1,20}")
HANDS_IN = {"r": "right", "right": "right", "l": "left", "left": "left", "b": "both", "both": "both"}
HANDS_OUT = {"right": "R", "left": "L", "both": "B"}


def load_schema(name) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))


def _type_ok(value, name) -> bool:
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    raise ValueError(f"unsupported type {name}")


def schema_errors(value, schema, root=None, path="") -> list[str]:
    if root is None:
        root = schema
    for key in schema:
        if key not in SUPPORTED_KEYWORDS:
            raise ValueError(f"unsupported schema keyword {key}")
    if "$ref" in schema:
        ref = schema["$ref"]
        prefix = "#/$defs/"
        if not ref.startswith(prefix) or ref[len(prefix) :] not in root.get("$defs", {}):
            raise ValueError(f"unsupported $ref {ref}")
        return schema_errors(value, root["$defs"][ref[len(prefix) :]], root, path)
    errors: list[str] = []
    if "type" in schema:
        names = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_type_ok(value, n) for n in names):
            return [f"{path}: expected {' or '.join(names)}"]
    if "const" in schema:
        c = schema["const"]
        if value != c or isinstance(value, bool) != isinstance(c, bool):
            errors.append(f"{path}: expected {json.dumps(c)}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: expected one of {', '.join(json.dumps(e) for e in schema['enum'])}")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than {schema['minLength']} characters")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append(f"{path}: longer than {schema['maxLength']} characters")
        if "pattern" in schema and not re.fullmatch(schema["pattern"].removeprefix("^").removesuffix("$"), value):
            errors.append(f"{path}: does not match {schema['pattern']}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{path}: {value} is below the minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{path}: {value} is above the maximum {schema['maximum']}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{path}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                errors += schema_errors(item, schema["items"], root, f"{path}[{i}]")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required key {key}")
        props = schema.get("properties", {})
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            sub = f"{path}.{key}" if path else key
            if "propertyNames" in schema:
                errors += [
                    e.replace(": ", f": property name {key}: ", 1)
                    for e in schema_errors(key, schema["propertyNames"], root, path)
                ]
            if key in props:
                errors += schema_errors(item, props[key], root, sub)
            elif extra is False:
                errors.append(f"{sub}: unexpected key")
            elif isinstance(extra, dict):
                errors += schema_errors(item, extra, root, sub)
    return errors


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path.name} is not valid JSON: {e}")


_S1_OLD = re.compile(r'("id"\s*:\s*"S1"\s*,[^{}\[\]]*?"requires"\s*:\s*)\[\s*"K1"\s*\]')


def migrate_tree(plan_dir) -> bool:
    """One-off fix for plans made before S1 lost its K1 prerequisite."""
    try:
        tree_path = Path(plan_dir) / TREE_FILE
        try:
            text = tree_path.read_bytes().decode("utf-8")
            tree = json.loads(text)
        except (OSError, UnicodeDecodeError, ValueError):
            return False
        if not isinstance(tree, dict) or not isinstance(tree.get("nodes"), list):
            return False
        s1 = [n for n in tree["nodes"] if isinstance(n, dict) and n.get("id") == "S1"]
        if len(s1) != 1 or s1[0].get("requires") != ["K1"]:
            return False
        s1[0]["requires"] = []
        fixed = tree
        new_text, count = _S1_OLD.subn(r"\1[]", text)
        ok = False
        if count == 1:
            try:
                ok = json.loads(new_text) == fixed
            except ValueError:
                ok = False
        if not ok:
            nl = "\r\n" if "\r\n" in text else "\n"
            new_text = json.dumps(fixed, indent=2, ensure_ascii=False).replace("\n", nl) + nl
        tmp = None
        try:
            fd, tmp = tempfile.mkstemp(dir=tree_path.parent, prefix=".tree.json.", suffix=".tmp")
            with os.fdopen(fd, "wb") as f:
                f.write(new_text.encode("utf-8"))
            try:
                shutil.copymode(tree_path, tmp)
            except OSError:
                pass
            os.replace(tmp, tree_path)
            return True
        except OSError:
            if tmp is not None and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
            return False
    except Exception:
        return False


# Technique track before the old K4 (thumb-under C/G/F scales, a repeat of S1) was dropped:
# drill suffixes per old node number; old node n had drills k{n}.<suffix> on scores gen:k{n}-<suffix>.
_OLD_TECHNIQUE = {
    4: ("c-rh", "c-lh", "g-rh", "g-lh", "f-rh", "f-lh"),
    5: ("c-to-g", "octave-rh", "octave-lh", "c-to-a", "no-rest"),
    6: ("c-chord-rh", "c-chord-lh", "c-g7-rh", "c-f-g-lh", "chords-quarters"),
    7: ("broken-c-rh", "broken-lh", "alberti-lh", "arpeggio-rh", "broken-c-f-g"),
}
_TECHNIQUE_RENAME = {f"K{n}": f"K{n - 1}" for n in (5, 6, 7)}
_TECHNIQUE_GONE = sorted(_TECHNIQUE_RENAME)[-1]  # the old top node id; no node has it after the fix
TECHNIQUE_FIX = "technique K4 removed (it repeated S1), later technique nodes moved down by one"


def _old_scores(n) -> set:
    return {f"gen:k{n}-{s}" for s in _OLD_TECHNIQUE[n]}


def _technique_tree_is_old(nodes) -> bool:
    if not all(k in nodes for k in ("K5", "K6", _TECHNIQUE_GONE, "K2", "S1")):
        return False
    for n in (5, 6, 7):
        if not any(d.get("score") in _old_scores(n) for d in nodes[f"K{n}"]["drills"]):
            return False
    if "K4" not in nodes:
        return True
    return sorted(d.get("score") for d in nodes["K4"]["drills"]) == sorted(_old_scores(4))


def _technique_tree_is_new(nodes) -> bool:
    if _TECHNIQUE_GONE in nodes or "K6" not in nodes:
        return False
    new_scores = {f"gen:k6-{s}" for s in _OLD_TECHNIQUE[7]}
    return any(d.get("score") in new_scores for d in nodes["K6"]["drills"])


def _state_has_gone(state) -> bool:
    if _TECHNIQUE_GONE in state["nodes"]:
        return True
    return any(_TECHNIQUE_GONE in h["nodes"] for h in state["habits"] if isinstance(h, dict) and isinstance(h.get("nodes"), list))


def _fix_technique_tree(tree):
    tree = copy.deepcopy(tree)
    tree["nodes"] = [n for n in tree["nodes"] if not (isinstance(n, dict) and n.get("id") == "K4")]
    for node in tree["nodes"]:
        old_id = node.get("id")
        new_id = _TECHNIQUE_RENAME.get(old_id, old_id)
        requires = []
        for r in node["requires"]:
            mapped = ["K2", "S1"] if r == "K4" else [_TECHNIQUE_RENAME.get(r, r)]
            for x in mapped:
                if x != new_id and x not in requires:
                    requires.append(x)
        node["requires"] = requires
        node["id"] = new_id
        for n in (5, 6, 7):
            if old_id == f"K{n}":
                for d in node["drills"]:
                    if d["id"].startswith(f"k{n}."):
                        d["id"] = f"k{n - 1}." + d["id"][len(f"k{n}.") :]
                    if d["score"].startswith(f"gen:k{n}-"):
                        d["score"] = f"gen:k{n - 1}-" + d["score"][len(f"gen:k{n}-") :]
    return tree


def _fix_technique_state(state):
    state = copy.deepcopy(state)
    nodes = {}
    for nid, entry in state["nodes"].items():
        if nid != "K4":
            nodes[_TECHNIQUE_RENAME.get(nid, nid)] = entry
    state["nodes"] = nodes
    for habit in state["habits"]:
        if isinstance(habit, dict) and isinstance(habit.get("nodes"), list):
            ids = []
            for nid in habit["nodes"]:
                new_id = _TECHNIQUE_RENAME.get(nid, nid)
                if nid != "K4" and new_id not in ids:
                    ids.append(new_id)
            habit["nodes"] = ids
    return state


def _dump_like(obj, text) -> str:
    if "\n" not in text:
        return json.dumps(obj, ensure_ascii=False)
    nl = "\r\n" if "\r\n" in text else "\n"
    out = json.dumps(obj, indent=2, ensure_ascii=False).replace("\n", nl)
    return out + nl if text.endswith("\n") else out


def _replace_text(path, text) -> bool:
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(text.encode("utf-8"))
        try:
            shutil.copymode(path, tmp)
        except OSError:
            pass
        os.replace(tmp, path)
        return True
    except OSError:
        if tmp is not None and os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return False


def migrate_technique(plan_dir) -> bool:
    """One-off fix for plans made before the old technique K4 was dropped."""
    try:
        tree_path = Path(plan_dir) / TREE_FILE
        state_path = Path(plan_dir) / STATE_FILE
        # State is read first so concurrent callers (/api/plan polling during coach evidence) never rename an old tree against an already-new state.
        state = state_text = None
        if state_path.exists():
            try:
                state_text = state_path.read_bytes().decode("utf-8")
                state = json.loads(state_text)
            except (OSError, UnicodeDecodeError, ValueError):
                return False
            if not isinstance(state, dict) or not isinstance(state.get("nodes"), dict) or not isinstance(state.get("habits"), list):
                return False
        try:
            tree_text = tree_path.read_bytes().decode("utf-8")
            tree = json.loads(tree_text)
        except (OSError, UnicodeDecodeError, ValueError):
            return False
        if not isinstance(tree, dict) or not isinstance(tree.get("nodes"), list):
            return False
        nodes = {n["id"]: n for n in tree["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)}
        new_tree = new_state = None
        if _technique_tree_is_old(nodes):
            new_tree = _fix_technique_tree(tree)
            if state is not None:
                new_state = _fix_technique_state(state)
        elif _technique_tree_is_new(nodes) and state is not None and _state_has_gone(state):
            new_state = _fix_technique_state(state)
        else:
            return False
        wrote = False
        if new_tree is not None:
            if not _replace_text(tree_path, _dump_like(new_tree, tree_text)):
                return False
            wrote = True
        if new_state is not None and new_state != state:
            if _replace_text(state_path, _dump_like(new_state, state_text)):
                wrote = True
        return wrote
    except Exception:
        return False


SKILL_TREE_FIX = "skill tree redesign: new nodes and drills from the seed, duplicate drills removed, snippet nodes R9/R10 merged into R2/R3"
_REDESIGN_REMOVED = frozenset(
    "r5.read-2 r8.sight-1 r8.sight-2 r8.sight-3 r8.sight-4 r8.sight-5 t4.after-rest t5.dotted-34 t7.triplets-34 "
    "k6.arpeggio-rh c2.waltz c4.waltz d2.waltz d3.phrase-34".split()
)
_REDESIGN_CHANGED = frozenset(
    "c2.held-c-g c3.octaves c3.contrary c3.tenths-halves c3.tenths-quarters c3.melody-bass c4.quarters-halves "
    "c4.eighths-quarters c4.halves-quarters c4.dotted-tune d2.held-bass d2.chords d2.lh-tune d2.alberti d3.cresc-rh "
    "d3.cresc-lh d3.both-hands r4.middle-c r4.read-1 r4.read-2 r4.read-3 "
    "ear.updown-2 s2.a-natural-rh s2.a-natural-lh s2.a-harmonic-rh s2.a-harmonic-lh t6.syncopation".split()
)
_SNIPPETS = (("R9", "R2", "r2."), ("R10", "R3", "r3."))


def _remap_requires(requires, merged, own_id):
    out = []
    for r in requires:
        r = merged.get(r, r)
        if r != own_id and r not in out:
            out.append(r)
    return out


def _rebase_skill_tree(tree, seed, merged):
    live = [n for n in tree["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)]
    live_by_id = {n["id"]: n for n in live}
    live_tracks = {t.get("id") for t in tree.get("tracks", []) if isinstance(t, dict)}
    live_drills = {d["id"]: d for n in live for d in n.get("drills", [])}
    seed_ids = {n["id"] for n in seed["nodes"]}
    seed_drill_ids = {d["id"] for n in seed["nodes"] for d in n["drills"]}
    live_only = [n for n in live if n["id"] not in seed_ids and n["id"] not in merged]
    kept_ids = {d["id"] for n in live_only for d in n.get("drills", [])}
    keep_sr = any(i.startswith("sr.") for i in live_drills)

    def extras(node):
        return [
            copy.deepcopy(d)
            for d in node.get("drills", [])
            if d["id"] not in seed_drill_ids and d["id"] not in _REDESIGN_REMOVED and d["id"] not in kept_ids
        ]

    out = []
    for snode in seed["nodes"]:
        if snode.get("track") in ("scales", "ear") and snode["track"] not in live_tracks:
            continue
        node = copy.deepcopy(snode)
        drills = []
        for d in node["drills"]:
            if d["id"] in kept_ids or (d["id"].startswith("sr.") and not keep_sr):
                continue
            if d["id"] in live_drills and d["id"] not in _REDESIGN_CHANGED:
                d = copy.deepcopy(live_drills[d["id"]])
            drills.append(d)
        node["drills"] = drills
        lnode = live_by_id.get(node["id"])
        if lnode is not None:
            if "gates" in lnode:
                node["gates"] = copy.deepcopy(lnode["gates"])
            node["drills"] += extras(lnode)
            for sid, target in merged.items():
                if target == node["id"] and sid in live_by_id:
                    node["drills"] += extras(live_by_id[sid])
            for r in lnode.get("requires", []):
                if r in kept_ids_nodes(live_only) and r not in node["requires"]:
                    node["requires"].append(r)
        out.append(node)
    for lnode in live_only:
        node = copy.deepcopy(lnode)
        node["requires"] = _remap_requires(node.get("requires", []), merged, node["id"])
        pos = len(out)
        i = live.index(lnode)
        present = {n["id"]: k for k, n in enumerate(out)}
        for prev in reversed(live[:i]):
            if prev["id"] in present:
                pos = present[prev["id"]] + 1
                break
        out.insert(pos, node)
    new = copy.deepcopy(tree)
    new["nodes"] = out
    seed_track_ids = {t["id"] for t in seed["tracks"]}
    tracks = [t for t in seed["tracks"] if t["id"] not in ("scales", "ear") or t["id"] in live_tracks]
    new["tracks"] = tracks + [t for t in tree.get("tracks", []) if isinstance(t, dict) and t.get("id") not in seed_track_ids]
    return new


def kept_ids_nodes(live_only):
    return {n["id"] for n in live_only}


def _merge_snippets_in_tree(tree, seed, merged):
    new = copy.deepcopy(tree)
    by_id = {n["id"]: n for n in new["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)}
    seed_nodes = {n["id"]: n for n in seed["nodes"]}
    for sid, target in merged.items():
        tnode = by_id[target]
        union = tnode["drills"] + by_id[sid]["drills"]
        order = [d["id"] for d in seed_nodes[target]["drills"]] if target in seed_nodes else []
        rank = {i: k for k, i in enumerate(order)}
        known = sorted((d for d in union if d["id"] in rank), key=lambda d: rank[d["id"]])
        seen = set()
        tnode["drills"] = []
        for d in known + [d for d in union if d["id"] not in rank]:
            if d["id"] not in seen:
                seen.add(d["id"])
                tnode["drills"].append(d)
    new["nodes"] = [n for n in new["nodes"] if not (isinstance(n, dict) and n.get("id") in merged)]
    for n in new["nodes"]:
        if isinstance(n, dict) and isinstance(n.get("requires"), list):
            n["requires"] = _remap_requires(n["requires"], merged, n.get("id"))
    return new


def _fix_snippet_state(state, gone):
    state = copy.deepcopy(state)
    for sid in gone:
        state["nodes"].pop(sid, None)
    for habit in state["habits"]:
        if isinstance(habit, dict) and isinstance(habit.get("nodes"), list):
            ids = []
            for nid in habit["nodes"]:
                nid = gone.get(nid, nid)
                if nid not in ids:
                    ids.append(nid)
            habit["nodes"] = ids
    return state


def migrate_skill_tree(plan_dir) -> bool:
    """One-off fix for plans made before the skill tree redesign."""
    try:
        tree_path = Path(plan_dir) / TREE_FILE
        state_path = Path(plan_dir) / STATE_FILE
        state = state_text = None
        if state_path.exists():
            try:
                state_text = state_path.read_bytes().decode("utf-8")
                state = json.loads(state_text)
            except (OSError, UnicodeDecodeError, ValueError):
                return False
            if not isinstance(state, dict) or not isinstance(state.get("nodes"), dict) or not isinstance(state.get("habits"), list):
                return False
        try:
            tree_text = tree_path.read_bytes().decode("utf-8")
            tree = json.loads(tree_text)
        except (OSError, UnicodeDecodeError, ValueError):
            return False
        if not isinstance(tree, dict) or not isinstance(tree.get("nodes"), list):
            return False
        nodes = {n["id"]: n for n in tree["nodes"] if isinstance(n, dict) and isinstance(n.get("id"), str)}
        merged = {}
        for sid, target, prefix in _SNIPPETS:
            node = nodes.get(sid)
            if node is not None and target in nodes and all(isinstance(d, dict) and str(d.get("id", "")).startswith(prefix) for d in node.get("drills", [])):
                merged[sid] = target
        r8 = nodes.get("R8")
        is_old = (
            "M1" not in nodes
            and "R1" in nodes
            and r8 is not None
            and any(str(d.get("score", "")).startswith("gen:r8-sight-") for d in r8.get("drills", []))
            and _technique_tree_is_new(nodes)
        )
        new_tree = None
        if is_old:
            new_tree = _rebase_skill_tree(tree, load_json(SEED_TREE), merged)
        elif "M1" in nodes:
            if merged:
                new_tree = _merge_snippets_in_tree(tree, load_json(SEED_TREE), merged)
        else:
            return False
        final = new_tree if new_tree is not None else tree
        if new_tree is not None and validate_tree(new_tree):
            return False
        final_ids = {n.get("id") for n in final["nodes"] if isinstance(n, dict)}
        new_state = None
        if state is not None:
            gone = {sid: target for sid, target, _ in _SNIPPETS if sid not in final_ids and target in final_ids}
            if gone:
                new_state = _fix_snippet_state(state, gone)
        wrote = False
        if new_tree is not None:
            if not _replace_text(tree_path, _dump_like(new_tree, tree_text)):
                return False
            wrote = True
        if new_state is not None and new_state != state:
            if _replace_text(state_path, _dump_like(new_state, state_text)):
                wrote = True
        return wrote
    except Exception:
        return False


def merged_gates(tree, node) -> dict:
    out = {}
    for level in LEVELS:
        gate = dict(tree["default_gates"][level])
        gate.update(node.get("gates", {}).get(level, {}))
        out[level] = gate
    return out


def drill_index(tree) -> dict:
    index = {}
    for node in tree.get("nodes", []):
        for drill in node.get("drills", []):
            index[drill["id"]] = (node, drill)
    return index


def _check_gates(tree, schema, i, node) -> list[str]:
    errors = []
    merged = merged_gates(tree, node)
    for level in LEVELS:
        p = f"nodes[{i}].gates.{level}"
        gate = merged[level]
        found = schema_errors(gate, schema["$defs"]["gate_" + level], schema, p)
        if found:
            errors += found
            continue
        floors = {**GATE_FLOORS[level], **TRACK_GATE_FLOORS.get(node.get("track"), {}).get(level, {})}
        for key, floor in floors.items():
            if key in gate and gate[key] < floor:
                errors.append(f"{p}.{key}: {gate[key]} is below the floor {floor}")
        if "evenness" in gate and gate["evenness"] < EVENNESS_FLOOR:
            errors.append(f"{p}.evenness: {gate['evenness']} is below the floor {EVENNESS_FLOOR}")
        if not gate["holds"]:
            errors.append(f"{p}.holds: must be true")
        if level == "solid":
            if gate["window"] > 7:
                errors.append(f"{p}.window: {gate['window']} is above the maximum 7")
            if gate["window"] < gate["clean_in_window"]:
                errors.append(f"{p}.window: {gate['window']} is below clean_in_window {gate['clean_in_window']}")
            if not gate["habit_free"]:
                errors.append(f"{p}.habit_free: must be true")
    return errors


def validate_tree(tree) -> list[str]:
    schema = load_schema("tree.schema.json")
    found = schema_errors(tree, schema)
    if found:
        return [f"tree.json: {e}" for e in found]
    errors = []
    nodes = tree["nodes"]
    ids = set()
    for i, node in enumerate(nodes):
        if node["id"] in ids:
            errors.append(f"nodes[{i}].id: duplicate node id {node['id']}")
        ids.add(node["id"])
    drills = set()
    for i, node in enumerate(nodes):
        for j, drill in enumerate(node["drills"]):
            if drill["id"] in drills:
                errors.append(f"nodes[{i}].drills[{j}].id: duplicate drill id {drill['id']}")
            drills.add(drill["id"])
            if drill.get("ramp") is True and drill["loop"] is False:
                errors.append(f"nodes[{i}].drills[{j}].ramp: a ramp needs loop true")
    tracks = {t["id"] for t in tree["tracks"]}
    for i, node in enumerate(nodes):
        for req in node["requires"]:
            if req == node["id"]:
                errors.append(f"nodes[{i}].requires: {req} requires itself")
            elif req not in ids:
                errors.append(f"nodes[{i}].requires: unknown prerequisite {req}")
        if node["track"] not in tracks:
            errors.append(f"nodes[{i}].track: unknown track {node['track']}")
        if node.get("kind") == "piece" and not node.get("score"):
            errors.append(f"nodes[{i}].score: a piece node needs a score")
        errors += _check_gates(tree, schema, i, node)
    errors += _cycle_errors(nodes, ids)
    return [f"tree.json: {e}" for e in errors]


def _cycle_errors(nodes, ids) -> list[str]:
    requires = {n["id"]: [r for r in n["requires"] if r in ids and r != n["id"]] for n in nodes}
    state = {}
    errors = []

    def visit(nid, stack):
        state[nid] = 1
        stack.append(nid)
        for r in requires[nid]:
            if state.get(r) == 1:
                errors.append("prerequisite cycle: " + " -> ".join(stack[stack.index(r) :] + [r]))
            elif r not in state:
                visit(r, stack)
        stack.pop()
        state[nid] = 2

    for nid in requires:
        if nid not in state:
            visit(nid, [])
    return errors


def validate_state(state, tree) -> tuple[list[str], list[str]]:
    found = schema_errors(state, load_schema("state.schema.json"))
    if found:
        return [f"state.json: {e}" for e in found], []
    errors, warnings = [], []
    tree_nodes = {n["id"]: n for n in tree.get("nodes", [])}
    habit_ids = set()
    for habit in state["habits"]:
        if habit["id"] in habit_ids:
            errors.append(f"state.json: habits: duplicate habit id {habit['id']}")
        habit_ids.add(habit["id"])
    for habit in state["habits"]:
        for nid in habit["nodes"]:
            if nid not in tree_nodes:
                errors.append(f"state.json: habits.{habit['id']}: unknown node {nid}")
    for nid, entry in state["nodes"].items():
        if nid not in tree_nodes:
            errors.append(f"state.json: nodes.{nid}: unknown node")
            continue
        for hid in entry.get("habits", []):
            if hid not in habit_ids:
                errors.append(f"state.json: nodes.{nid}: unknown habit {hid}")
        level = entry["level"]
        if "max_level" in entry and level > entry["max_level"]:
            errors.append(f"state.json: nodes.{nid}: level {level} is above the gate floor (max {entry['max_level']})")
        if level > 0:
            for req in tree_nodes[nid]["requires"]:
                if state["nodes"].get(req, {}).get("level", 0) < 2:
                    warnings.append(f"state.json: nodes.{nid}: level {level} while locked")
                    break
    return errors, warnings


def encode_score_id(id) -> str:
    return urllib.parse.quote(id, safe="").replace("%3A", ":")


def drill_hash(score_id, params) -> str:
    parts = []
    if "drill" in params:
        parts.append("drill=" + params["drill"])
    if "plan" in params:
        parts.append("plan=" + params["plan"])
    if "hands" in params:
        parts.append("hands=" + HANDS_OUT[params["hands"]])
    if "bars" in params:
        b = params["bars"]
        parts.append("bars=" + (str(b["from"]) if b["from"] == b["to"] else f"{b['from']}-{b['to']}"))
    if "tempo" in params:
        parts.append(f"tempo={params['tempo']}")
    if "mode" in params:
        parts.append("mode=" + params["mode"])
    if "loop" in params:
        parts.append("loop=" + ("1" if params["loop"] else "0"))
    if "ramp" in params:
        parts.append("ramp=" + ("1" if params["ramp"] else "0"))
    if "target" in params:
        parts.append(f"target={params['target']}")
    if params.get("tags"):
        parts.append("tag=" + ",".join(params["tags"]))
    return "#" + encode_score_id(score_id) + ("?" + "&".join(parts) if parts else "")


def _parse_link(query) -> dict:
    last = {}
    for key, value in urllib.parse.parse_qsl(query, keep_blank_values=True):
        last[key] = value
    link = {}
    for name, value in last.items():
        if name == "drill":
            if DRILL_RE.fullmatch(value):
                link["drill"] = value
        elif name == "plan":
            if PLAN_RE.fullmatch(value):
                link["plan"] = value
        elif name == "hands":
            if value.lower() in HANDS_IN:
                link["hands"] = HANDS_IN[value.lower()]
        elif name == "bars":
            m = re.fullmatch(r"([0-9]+)(?:-([0-9]+))?", value)
            if m:
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) is not None else start
                if start <= end:
                    link["bars"] = {"from": start, "to": end}
        elif name == "tempo":
            if re.fullmatch(r"[0-9]+", value) and 1 <= int(value) <= 300:
                link["tempo"] = int(value)
        elif name == "mode":
            if value in ("wait", "live"):
                link["mode"] = value
        elif name == "loop":
            if value in ("1", "true"):
                link["loop"] = True
            elif value in ("0", "false"):
                link["loop"] = False
        elif name == "ramp":
            if value in ("1", "true"):
                link["ramp"] = True
            elif value in ("0", "false"):
                link["ramp"] = False
        elif name == "target":
            if re.fullmatch(r"[0-9]+", value) and 1 <= int(value) <= 300:
                link["target"] = int(value)
        elif name == "tag":
            items = value.split(",")
            if 1 <= len(items) <= 10 and all(TAG_RE.fullmatch(t) for t in items):
                link["tags"] = items
    return link


def parse_drill_hash(hash) -> tuple:
    if hash in ("", "#") or hash in ("#/skills", "#/skills/"):
        return None, None
    if hash.startswith("#score="):
        rest = hash[len("#score=") :]
        cut = re.search(r"[&?]", rest)
        id_part = rest if cut is None else rest[: cut.start()]
        query = None if cut is None else rest[cut.start() + 1 :]
        is_score_form = True
    else:
        if hash.startswith("#/"):
            return None, None
        rest = hash[1:]
        cut = rest.find("?")
        id_part = rest if cut < 0 else rest[:cut]
        query = None if cut < 0 else rest[cut + 1 :]
        is_score_form = False
    if re.search(r"%(?![0-9A-Fa-f]{2})", id_part):
        return None, None
    try:
        score_id = urllib.parse.unquote(id_part, errors="strict")
    except UnicodeDecodeError:
        return None, None
    if score_id == "":
        return None, None
    if not is_score_form and ":" not in score_id:
        return None, None
    return score_id, (None if query is None else _parse_link(query))


def drill_params(drill, plan_id=None, tags=()) -> dict:
    params = {
        "drill": drill["id"],
        "hands": drill["hands"],
        "tempo": drill["tempo"],
        "mode": drill["mode"],
        "loop": drill["loop"],
    }
    if "ramp" in drill:
        params["ramp"] = drill["ramp"]
    if "target" in drill:
        params["target"] = drill["target"]
    if drill.get("bars") is not None:
        params["bars"] = {"from": drill["bars"]["from"], "to": drill["bars"]["to"]}
    if plan_id:
        params["plan"] = plan_id
    if tags:
        params["tags"] = list(tags)
    return params


def drill_url(score_id, params, base="http://localhost:5173/") -> str:
    return base + drill_hash(score_id, params)


def check_today(text, tree) -> list[str]:
    index = drill_index(tree)
    errors = []
    for target in re.findall(r"\]\(([^)\s]*)\)", text):
        if "#" not in target:
            continue
        score_id, params = parse_drill_hash(target[target.index("#") :])
        if score_id is None or not params or "drill" not in params:
            continue
        if params["drill"] not in index:
            errors.append(f"today.md: link to unknown drill '{params['drill']}'")
    return errors


def check_plan(plan_dir) -> tuple[list[str], list[str]]:
    plan_dir = Path(plan_dir)
    errors, warnings = [], []
    tree_path = plan_dir / TREE_FILE
    if not tree_path.exists():
        return ["tree.json: missing; run coach plan init"], warnings
    try:
        tree = load_json(tree_path)
    except ValueError as e:
        return [str(e)], warnings
    tree_errors = validate_tree(tree)
    errors += tree_errors
    state_path = plan_dir / STATE_FILE
    if not state_path.exists():
        warnings.append("state.json: missing; run coach plan init")
    else:
        try:
            state = load_json(state_path)
        except ValueError as e:
            errors.append(str(e))
        else:
            if not tree_errors:
                e, w = validate_state(state, tree)
                errors += e
                warnings += w
    today_path = plan_dir / TODAY_FILE
    if today_path.exists() and not tree_errors:
        errors += check_today(today_path.read_text(encoding="utf-8"), tree)
    return errors, warnings


def init_plan(plan_dir) -> list[Path]:
    plan_dir = Path(plan_dir)
    created = []
    plan_dir.mkdir(parents=True, exist_ok=True)
    tree_path = plan_dir / TREE_FILE
    if not tree_path.exists():
        if not SEED_TREE.exists():
            raise FileNotFoundError(f"seed tree not found: {SEED_TREE}")
        shutil.copyfile(SEED_TREE, tree_path)
        created.append(tree_path)
    state_path = plan_dir / STATE_FILE
    if not state_path.exists():
        state = {
            "version": 1,
            "kind": "rusty_piano.state",
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "last_review": None,
            "plan_id": None,
            "nodes": {},
            "habits": [],
        }
        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        created.append(state_path)
    for name in ("journal", "pieces"):
        folder = plan_dir / name
        if not folder.exists():
            folder.mkdir()
            created.append(folder)
    return created


def add_plan_parser(subparsers):
    pl = subparsers.add_parser("plan", help="practice plan: check the files, create them, build drill links")
    psub = pl.add_subparsers(dest="plan_command", required=True)
    default_help = "plan folder (default: RUSTY_PIANO_DATA_DIR/plan or coach/data/plan)"
    ck = psub.add_parser("check", help="validate tree.json, state.json and today.md")
    ck.add_argument("--plan-dir", default=None, help=default_help)
    it = psub.add_parser("init", help="create tree.json and state.json if missing (never overwrites)")
    it.add_argument("--plan-dir", default=None, help=default_help)
    lk = psub.add_parser("link", help="print a drill link for the sheet music page")
    lk.add_argument("drill_id", nargs="?", default=None, help="drill id from tree.json")
    lk.add_argument("--plan-dir", default=None, help=default_help)
    lk.add_argument("--score", default=None, help="score id (needed without a drill id)")
    lk.add_argument("--bars", default=None, help="bar range A or A-B")
    lk.add_argument("--hands", choices=["right", "left", "both"], default=None, help="which hands the page plays and expects")
    lk.add_argument("--tempo", type=int, default=None, help="tempo percent (1-300)")
    lk.add_argument("--mode", choices=["wait", "live"], default=None, help="follower mode: wait or live")
    lk.add_argument("--loop", action=argparse.BooleanOptionalAction, default=None, help="loop the bars (--no-loop for no loop)")
    lk.add_argument("--ramp", action=argparse.BooleanOptionalAction, default=None, help="Ramp toggle: speed the loop up after each clean run")
    lk.add_argument("--target", type=int, default=None, help="ramp target tempo percent (1-300)")
    lk.add_argument("--plan", default=None, help="plan id, e.g. 2026-11-05")
    lk.add_argument("--tag", action="append", default=None, help="tag (repeatable)")
    lk.add_argument("--base", default="http://localhost:5173/", help="page address")


def _run_link(args, plan_dir) -> int:
    tags = args.tag or ()
    if args.drill_id:
        tree_path = plan_dir / TREE_FILE
        if not tree_path.exists():
            print("error: tree.json: missing; run coach plan init")
            return 1
        try:
            tree = load_json(tree_path)
        except ValueError as e:
            print(f"error: {e}")
            return 1
        found = drill_index(tree).get(args.drill_id)
        if found is None:
            print(f"error: unknown drill '{args.drill_id}'")
            return 1
        drill = found[1]
        params = drill_params(drill, args.plan, tags)
        score = args.score or drill["score"]
    else:
        if not args.score:
            print("error: give a drill id or --score")
            return 2
        params = {}
        if args.plan:
            params["plan"] = args.plan
        if tags:
            params["tags"] = list(tags)
        score = args.score
    if args.bars is not None:
        m = re.fullmatch(r"([0-9]+)(?:-([0-9]+))?", args.bars)
        if not m or (m.group(2) is not None and int(m.group(1)) > int(m.group(2))):
            print("error: --bars must be A or A-B")
            return 2
        start = int(m.group(1))
        params["bars"] = {"from": start, "to": int(m.group(2)) if m.group(2) is not None else start}
    if args.hands is not None:
        params["hands"] = args.hands
    if args.tempo is not None:
        params["tempo"] = args.tempo
    if args.mode is not None:
        params["mode"] = args.mode
    if args.loop is not None:
        params["loop"] = args.loop
    if args.target is not None and not 1 <= args.target <= 300:
        print("error: --target must be 1-300")
        return 2
    if args.ramp is not None:
        params["ramp"] = args.ramp
    if args.target is not None:
        params["target"] = args.target
    print(drill_url(score, params, args.base))
    return 0


def run_plan(args) -> int:
    plan_dir = data_paths.plan_dir(args.plan_dir)
    if args.plan_command == "check":
        if migrate_tree(plan_dir):
            print("fixed: tree.json: S1 no longer requires K1")
        if migrate_technique(plan_dir):
            print(f"fixed: tree.json, state.json: {TECHNIQUE_FIX}")
        if migrate_skill_tree(plan_dir):
            print(f"fixed: tree.json, state.json: {SKILL_TREE_FIX}")
        errors, warnings = check_plan(plan_dir)
        for e in errors:
            print(f"error: {e}")
        for w in warnings:
            print(f"warning: {w}")
        if errors:
            return 1
        tree = load_json(plan_dir / TREE_FILE)
        n_drills = sum(len(n["drills"]) for n in tree["nodes"])
        print(f"Plan OK: {len(tree['nodes'])} nodes, {n_drills} drills")
        return 0
    if args.plan_command == "init":
        try:
            created = init_plan(plan_dir)
        except FileNotFoundError as e:
            print(f"error: {e}")
            return 1
        for path in created:
            print(f"created {path}")
        if not created:
            print(f"Plan files already exist in {plan_dir}")
        return 0
    return _run_link(args, plan_dir)
