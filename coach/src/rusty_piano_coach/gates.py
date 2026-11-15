"""Level gates per tree node: good, solid and mastered progress from counted runs, plus lock and rusty flags."""

import copy
from datetime import date

from . import plan, runs as runs_mod

DEFAULT_COLD_RUNS_PER_DRILL = 2


def _solid_counts(group, gate, drill_of, piece):
    last = group[-gate["window"] :]
    clean = [r for r in last if runs_mod.is_clean(r, gate, drill_of(r), piece)]
    return len(clean), len({r.day for r in clean})


def _drill_progress(drill, rs, gates, habit_free):
    rs = sorted(rs, key=lambda r: (r.started_at, r.cycle or 0))

    def drill_of(r):
        return drill

    g = gates["good"]
    clean = [r for r in rs if runs_mod.is_clean(r, g, drill, False)]
    good_days = len({r.day for r in clean})
    good_met = len(clean) >= g["clean_runs"] and good_days >= g["days"]
    good = {
        "met": good_met,
        "clean_runs": len(clean),
        "need_runs": g["clean_runs"],
        "days": good_days,
        "need_days": g["days"],
    }

    g = gates["solid"]
    n_clean, n_days = _solid_counts(rs, g, drill_of, False)
    solid_met = bool(
        good_met
        and n_clean >= g["clean_in_window"]
        and n_days >= g["days"]
        and (habit_free or not g["habit_free"])
    )
    solid = {
        "met": solid_met,
        "clean_in_window": n_clean,
        "need_clean": g["clean_in_window"],
        "window": g["window"],
        "days": n_days,
        "need_days": g["days"],
    }

    g = gates["mastered"]
    cold = 0
    for i in range(1, len(rs)):
        if (rs[i].day - rs[i - 1].day).days >= g["away_days"] and runs_mod.is_clean(rs[i], g, drill, False):
            cold += 1
    need_cold = g.get("cold_runs_per_drill", DEFAULT_COLD_RUNS_PER_DRILL)
    mastered_met = bool(solid_met and cold >= need_cold)
    mastered = {"met": mastered_met, "cold_runs": cold, "need_cold": need_cold}

    if not rs:
        level = 0
    elif mastered_met:
        level = 4
    elif solid_met:
        level = 3
    elif good_met:
        level = 2
    else:
        level = 1
    return {"runs": len(rs), "level": level, "good": good, "solid": solid, "mastered": mastered}


def _node_gates(drills, gates, habit_free):
    total = len(drills)

    def count(threshold):
        missing = [did for did, d in drills.items() if d["level"] < threshold]
        return total - len(missing), missing

    good_n, good_missing = count(2)
    solid_n, solid_missing = count(3)
    mast_n, mast_missing = count(4)
    good = {
        "met": total > 0 and good_n == total,
        "drills_met": good_n,
        "drills_total": total,
        "missing": good_missing,
        "need_runs": gates["good"]["clean_runs"],
        "need_days": gates["good"]["days"],
    }
    solid = {
        "met": total > 0 and solid_n == total,
        "drills_met": solid_n,
        "drills_total": total,
        "missing": solid_missing,
        "need_clean": gates["solid"]["clean_in_window"],
        "window": gates["solid"]["window"],
        "need_days": gates["solid"]["days"],
        "habit_free": habit_free,
    }
    mastered = {
        "met": total > 0 and mast_n == total,
        "drills_met": mast_n,
        "drills_total": total,
        "missing": mast_missing,
        "need_cold": gates["mastered"].get("cold_runs_per_drill", DEFAULT_COLD_RUNS_PER_DRILL),
        "away_days": gates["mastered"]["away_days"],
    }
    return good, solid, mastered


def node_progress(tree: dict | None, state: dict | None, runs: list, today: date) -> dict:
    if not tree:
        return {}
    state = state or {}
    state_nodes = state.get("nodes") or {}
    index = plan.drill_index(tree)

    def level_of(nid):
        entry = state_nodes.get(nid)
        try:
            return int(entry["level"]) if entry and "level" in entry else 0
        except (TypeError, ValueError):
            return 0

    out = {}
    for node in tree.get("nodes", []):
        nid = node["id"]
        piece = node.get("kind", "skill") == "piece"
        drill_ids = {d["id"] for d in node.get("drills", [])}
        if piece:
            mine = [r for r in runs if r.score_id == node.get("score")]
        else:
            mine = [r for r in runs if r.drill_id in drill_ids]
        mine = sorted(mine, key=lambda r: (r.started_at, r.cycle or 0))
        gates = plan.merged_gates(tree, node)

        def drill_of(r, piece=piece):
            if piece or r.drill_id not in index:
                return None
            return index[r.drill_id][1]

        def clean_at(r, gate, piece=piece, drill_of=drill_of):
            return runs_mod.is_clean(r, gate, drill_of(r), piece)

        habit_free = not any(
            h.get("status") == "active" and nid in (h.get("nodes") or [])
            for h in state.get("habits") or []
        )
        if not piece:
            drills = {
                d["id"]: _drill_progress(d, [r for r in mine if r.drill_id == d["id"]], gates, habit_free)
                for d in node.get("drills", [])
            }
            good, solid, mastered = _node_gates(drills, gates, habit_free)
            good_met, solid_met = good["met"], solid["met"]

        if piece:
            g = gates["good"]
            clean = [r for r in mine if clean_at(r, g)]
            good_days = len({r.day for r in clean})
            good_met = len(clean) >= g["clean_runs"] and good_days >= g["days"]
            good = {
                "met": good_met,
                "clean_runs": len(clean),
                "need_runs": g["clean_runs"],
                "days": good_days,
                "need_days": g["days"],
            }

            g = gates["solid"]
            n_clean, n_days = _solid_counts(mine, g, drill_of, piece)
            solid_met = bool(
                good_met
                and n_clean >= g["clean_in_window"]
                and n_days >= g["days"]
                and (habit_free or not g["habit_free"])
            )
            solid = {
                "met": solid_met,
                "clean_in_window": n_clean,
                "need_clean": g["clean_in_window"],
                "window": g["window"],
                "days": n_days,
                "need_days": g["days"],
                "habit_free": habit_free,
            }

            g = gates["mastered"]
            cold = 0
            for i in range(1, len(mine)):
                if (mine[i].day - mine[i - 1].day).days >= g["away_days"] and clean_at(mine[i], g):
                    cold += 1
            groups: dict = {}
            for r in mine:
                groups.setdefault(r.score_id, []).append(r)
            sg = gates["solid"]
            materials = 0
            for group in groups.values():
                c, d = _solid_counts(group, sg, drill_of, piece)
                if c >= sg["clean_in_window"] and d >= sg["days"]:
                    materials += 1
            mastered = {
                "met": bool(solid_met and cold >= g["cold_runs"] and materials >= g["materials"]),
                "cold_runs": cold,
                "need_cold": g["cold_runs"],
                "materials": materials,
                "need_materials": g["materials"],
            }

        state_level = level_of(nid)
        locked = any(level_of(p) < 2 for p in node.get("requires") or [])
        if not mine:
            max_level = 0
        elif mastered["met"]:
            max_level = 4
        elif solid_met:
            max_level = 3
        elif good_met:
            max_level = 2
        else:
            max_level = 1
        last_seen = mine[-1].day.isoformat() if mine else None
        clean_days = [r.day for r in mine if clean_at(r, gates["good"])]
        last_clean_day = max(clean_days) if clean_days else None
        rusty = state_level >= 3 and (
            last_clean_day is None or (today - last_clean_day).days >= tree["decay_days"]
        )
        out[nid] = {
            "kind": node.get("kind", "skill"),
            "track": node.get("track"),
            "runs": len(mine),
            "last_seen": last_seen,
            "last_clean": last_clean_day.isoformat() if last_clean_day else None,
            "locked": locked,
            "max_level": max_level,
            "state_level": state_level,
            "rusty": rusty,
            "gates": {"good": good, "solid": solid, "mastered": mastered},
        }
        if not piece:
            out[nid]["drills"] = drills
    return out


def apply_to_state(state: dict, progress: dict) -> dict:
    new = copy.deepcopy(state)
    nodes = new.setdefault("nodes", {})
    for nid, p in progress.items():
        entry = nodes.get(nid) or {"level": 0, "verdict": "", "habits": []}
        for key in ("gates", "max_level", "last_seen", "last_clean", "rusty", "locked", "runs"):
            entry[key] = copy.deepcopy(p[key])
        if p.get("runs") and int(entry.get("level", 0)) > p["max_level"]:
            entry["level"] = p["max_level"]
            if entry["level"] < 3:
                entry["rusty"] = False
        if not p.get("runs"):
            entry.pop("gates", None)
        nodes[nid] = entry
    return new
