"""Evidence for the coach: aggregates saved attempts and reports into per-drill, per-piece, per-bar and per-feature stats, plus the player's own score notes (hard bars and notes) (what /coach reads)."""

import gc
import json
import os
import statistics
import sys
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from . import data_paths, ear, gates, habits, plan, practice_log, runs as runs_mod, sessions, sight
from . import evenness
from .library import score_notes
from .library.cli import DATA_DIR_HELP
from .library.index import Library
from .library.paths import resolve_data_dir
from .localzone import LOCAL

EVIDENCE_VERSION = 1
EVIDENCE_KIND = "rusty_piano.evidence"
REPORT_KIND = "rusty_piano.report"


def _parse_time(value, tz=timezone.utc):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=tz)


def _iso(value) -> str:
    return value.isoformat()


def _z(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_reports(reports_dir) -> tuple[list[dict], list[str]]:
    folder = Path(reports_dir)
    if not folder.is_dir():
        return [], []
    kept = []
    skipped = []
    for path in sorted(folder.glob("*.json"), key=lambda p: p.name):
        try:
            obj = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            skipped.append(f"{path.name}: unreadable ({e})")
            continue
        if isinstance(obj, dict) and obj.get("kind") == REPORT_KIND:
            kept.append(obj)
    return kept, skipped


def report_time(report, attempts_by_id) -> datetime | None:
    info = report.get("input") or {}
    linked = attempts_by_id.get(info.get("attempt_id"))
    if linked is not None:
        return _parse_time(linked.get("started_at"))
    return _parse_time(info.get("session_started_at")) or _parse_time(report.get("created_at"))


def load_score_keys(scores_dir, ids) -> dict[str, str | None]:
    if not ids or not (Path(scores_dir) / "library.sqlite").exists():
        return {}
    out = {}
    with Library(Path(scores_dir)) as lib:
        for score_id in ids:
            row = lib.get(score_id)
            out[score_id] = row["key"] if row else None
    return out


def load_sessions(sessions_dir, since=None) -> tuple[list[dict], list[str]]:
    out, skipped = [], []
    if sessions_dir is None:
        return out, skipped
    for path in sessions.sessions_in(Path(sessions_dir)):
        named = sessions.session_start_from_name(path.name)
        if since is not None and named is not None and named + timedelta(hours=12) < since:
            continue
        try:
            s = sessions.read_midi(path)
        except (ValueError, OSError) as e:
            skipped.append(f"{path.name}: {e}")
            continue
        if not s.notes or s.started_at is None or s.first_ms is None or s.last_ms is None:
            continue
        out.append(
            {
                "file": path.name,
                "start": s.started_at + timedelta(milliseconds=s.first_ms),
                "end": s.started_at + timedelta(milliseconds=s.last_ms),
                "active_minutes": sum(b - a for a, b in practice_log._active_spans(s.notes, practice_log.GAP_MS)) / 60000,
            }
        )
    return out, skipped


def _attempt_span(a):
    start = _parse_time(a.get("started_at"))
    if start is None:
        return None
    end = _parse_time(a.get("ended_at"))
    if end is None:
        d = a.get("duration_ms")
        end = start + timedelta(milliseconds=d) if isinstance(d, (int, float)) and not isinstance(d, bool) else start
    return start, end


def _sessions_block(window_sessions, all_attempts, all_reports):
    reported = set()
    for r in all_reports:
        mp = (r.get("input") or {}).get("midi_path")
        if isinstance(mp, str):
            reported.add(Path(mp).name)
    spans = [sp for sp in (_attempt_span(a) for a in all_attempts) if sp is not None]
    free = [
        s
        for s in window_sessions
        if s["file"] not in reported and not any(a0 <= s["end"] and s["start"] <= a1 for a0, a1 in spans)
    ]
    free.sort(key=lambda s: s["start"])
    return {
        "files": len(window_sessions),
        "minutes": round(sum(s["active_minutes"] for s in window_sessions), 1),
        "unanalysed_count": len(free),
        "unanalysed": [
            {
                "file": s["file"],
                "started_at": _z(s["start"]),
                "minutes": round(s["active_minutes"], 1),
            }
            for s in free[-20:]
        ],
    }


def _r3(value):
    return None if value is None else round(value, 3)


def _mean(values):
    return sum(values) / len(values) if values else None


def _distinct_attempts(rs, by_id):
    seen = []
    members = set()
    for r in rs:
        if r.attempt_id not in members:
            members.add(r.attempt_id)
            seen.append(r.attempt_id)
    return [by_id[i] for i in seen]


def _mean_accuracy(rs):
    return _r3(_mean([a for a in (runs_mod.run_accuracy(r) for r in rs) if a is not None]))


def _drill_entry(drill_id, rs, tree, index, by_id):
    node_drill = index.get(drill_id)
    node = node_drill[0] if node_drill else None
    drill = node_drill[1] if node_drill else None
    clean_good = clean_solid = 0
    if tree is not None:
        gate = plan.merged_gates(tree, node or {})
        clean_good = sum(1 for r in rs if runs_mod.is_clean(r, gate["good"], drill))
        clean_solid = sum(1 for r in rs if runs_mod.is_clean(r, gate["solid"], drill))
    accs = [a for a in (runs_mod.run_accuracy(r) for r in rs) if a is not None]
    atts = _distinct_attempts(rs, by_id)
    velocities = [v for a in atts for v in runs_mod.engine_velocities(a)]
    offsets = [s["offset_ms"] for r in rs for s in r.steps if s.get("offset_ms") is not None]
    graded = [t for t in (runs_mod.run_timing(r) for r in rs if r.counted and r.complete) if t is not None]
    entry = {
        "node": node["id"] if node else None,
        "score": rs[0].score_id,
        "runs": len(rs),
        "complete_runs": sum(1 for r in rs if r.complete),
        "clean_good": clean_good,
        "clean_solid": clean_solid,
        "mean_accuracy": _r3(_mean(accs)),
        "best_accuracy": _r3(max(accs)) if accs else None,
        "timing_score": round(_mean(graded) * 100) if graded else None,
        "days": len({r.day for r in rs}),
        "last_at": _iso(max(r.started_at for r in rs)),
        "max_tempo_percent": max(r.tempo_percent for r in rs),
        "velocity_spread": (
            runs_mod.percentile(velocities, 0.9) - runs_mod.percentile(velocities, 0.1)
            if len(velocities) >= 10
            else None
        ),
        "offset_sd_ms": round(statistics.pstdev(offsets), 1) if len(offsets) >= 5 else None,
    }
    if evenness.is_scale_score(rs[0].score_id):
        details = [d for d in (runs_mod.run_evenness_detail(r) for r in rs if r.counted and r.complete) if d]
        comb = [d["combined"] for d in details if d["combined"] is not None]
        align = [
            d["alignment"]["score"]
            for d in details
            if d["alignment"] is not None and d["alignment"]["score"] is not None
        ]
        entry["evenness"] = evenness.round_half_up(_mean(comb)) if comb else None
        entry["hands_alignment"] = evenness.round_half_up(_mean(align)) if align else None
    if ear.is_ear(rs[0].score_id):
        entry["ear"] = ear.drill_stats(rs)
    if sight.is_sight(rs[0].score_id):
        entry["sight"] = sight.drill_stats(rs)
    return entry


def _piece_entry(score_id, rs, by_id, reports):
    atts = _distinct_attempts(rs, by_id)
    stats = runs_mod.bar_stats(rs)
    bars = {}
    for bar, s in stats.items():
        entry = dict(s)
        entry["rushed"] = 0
        entry["dragged"] = 0
        bars[str(bar)] = entry
    for report in reports:
        if (report.get("score") or {}).get("id") != score_id:
            continue
        for row in report.get("bars") or []:
            entry = bars.get(str(row.get("bar")))
            if entry is None:
                continue
            if row.get("tempo") == "rushed":
                entry["rushed"] += 1
            elif row.get("tempo") == "dragged":
                entry["dragged"] += 1
    titles = [r.title for r in rs if r.title]
    return {
        "title": titles[-1] if titles else None,
        "runs": len(rs),
        "minutes": round(sum((a.get("duration_ms") or 0) for a in atts) / 60000, 1),
        "mean_accuracy": _mean_accuracy(rs),
        "last_at": _iso(max(r.started_at for r in rs)),
        "bars": bars,
        "hard_bars": runs_mod.hard_bars(stats),
    }


def _features(rs, by_id):
    steps = [s for r in rs for s in r.steps]
    timed = []
    offsets = []
    on_time = early = late = 0
    holds = []
    for s in steps:
        ok = runs_mod.timing_ok(s)
        if ok is not None:
            timed.append(s)
            offsets.append(s["offset_ms"])
            if ok:
                on_time += 1
            outcome = s.get("outcome")
            if outcome == "early":
                early += 1
            elif outcome == "late":
                late += 1
        holds.extend(s.get("holds") or [])
    short = sum(1 for h in holds if h.get("short"))
    velocities = [v for a in _distinct_attempts(rs, by_id) for v in runs_mod.engine_velocities(a)]
    p10 = runs_mod.percentile(velocities, 0.1)
    p90 = runs_mod.percentile(velocities, 0.9)
    n = len(timed)
    return {
        "timing": {
            "steps": n,
            "on_time_share": _r3(on_time / n) if n else None,
            "mean_offset_ms": round(sum(offsets) / n, 1) if n else None,
            "mean_abs_offset_ms": round(sum(abs(o) for o in offsets) / n, 1) if n else None,
            "early_share": _r3(early / n) if n else None,
            "late_share": _r3(late / n) if n else None,
        },
        "holds": {
            "checked": len(holds),
            "short": short,
            "short_share": _r3(short / len(holds)) if holds else None,
        },
        "velocity": {
            "notes": len(velocities),
            "p10": p10,
            "p90": p90,
            "spread": p90 - p10 if velocities else None,
        },
        "accuracy": {"mean": _mean_accuracy(rs)},
    }


def build_evidence(*, attempts_dir, reports_dir, plan_dir, scores_dir, since, today, tz, now, habit_days=14, sessions_dir=None) -> dict:
    was = gc.isenabled()
    gc.disable()
    try:
        with runs_mod.memoised():
            return _build_evidence(
                attempts_dir=attempts_dir,
                reports_dir=reports_dir,
                plan_dir=plan_dir,
                scores_dir=scores_dir,
                since=since,
                today=today,
                tz=tz,
                now=now,
                habit_days=habit_days,
                sessions_dir=sessions_dir,
            )
    finally:
        if was:
            gc.enable()


def _build_evidence(*, attempts_dir, reports_dir, plan_dir, scores_dir, since, today, tz, now, habit_days=14, sessions_dir=None) -> dict:
    warnings = []
    plan_dir = Path(plan_dir)
    tree = None
    state = None
    if plan.migrate_tree(plan_dir):
        warnings.append("tree.json: S1 no longer requires K1 (one-off fix)")
    try:
        tree = plan.load_json(plan_dir / plan.TREE_FILE)
    except (OSError, ValueError) as e:
        warnings.append(f"no usable tree.json ({e})")
    try:
        state = plan.load_json(plan_dir / plan.STATE_FILE)
    except (OSError, ValueError):
        state = None

    all_attempts, skipped = runs_mod.load_attempts(attempts_dir)
    all_reports, report_skipped = load_reports(reports_dir)
    loaded_sessions, session_skipped = load_sessions(sessions_dir, since)
    skipped = skipped + report_skipped + session_skipped
    by_id = {a["id"]: a for a in all_attempts}
    all_runs = runs_mod.load_runs(all_attempts, tz)

    def in_window(t, start):
        return start is None or (t is not None and t >= start)

    window_sessions = [s for s in loaded_sessions if in_window(s["start"], since)]
    window = [r for r in all_runs if in_window(r.started_at, since)]
    counted = [r for r in window if r.counted]
    window_attempts = [
        a for a in all_attempts if runs_mod.attempt_counted(a) and in_window(_parse_time(a["started_at"]), since)
    ]

    def report_ok(report, start):
        info = report.get("input") or {}
        linked = by_id.get(info.get("attempt_id"))
        if linked is not None and not runs_mod.attempt_counted(linked):
            return False
        return in_window(report_time(report, by_id), start)

    window_reports = [r for r in all_reports if report_ok(r, since)]

    reported = {(r.get("input") or {}).get("attempt_id") for r in all_reports}
    pending = [
        a["id"]
        for a in sorted(window_attempts, key=lambda a: _parse_time(a["started_at"]))
        if a["id"] not in reported and not (sight.is_sight(a["score"]["id"]) or ear.is_ear(a["score"]["id"]))
    ]

    index = plan.drill_index(tree) if tree else {}
    drill_runs: dict = {}
    plan_runs: dict = {}
    piece_runs: dict = {}
    for r in counted:
        if r.drill_id:
            drill_runs.setdefault(r.drill_id, []).append(r)
        if r.plan_id:
            plan_runs.setdefault(r.plan_id, []).append(r)
        if not (sight.is_sight(r.score_id) or ear.is_ear(r.score_id)):
            piece_runs.setdefault(r.score_id, []).append(r)

    if since is None:
        habit_since = None
    else:
        habit_since = min(since, datetime.combine(today, time(0), tzinfo=tz) - timedelta(days=habit_days))
    habit_runs = [r for r in all_runs if r.counted and in_window(r.started_at, habit_since)]
    habit_attempts = [
        a for a in all_attempts if runs_mod.attempt_counted(a) and in_window(_parse_time(a["started_at"]), habit_since)
    ]
    habit_reports = [r for r in all_reports if report_ok(r, habit_since)]
    keys = load_score_keys(scores_dir, sorted({a["score"]["id"] for a in habit_attempts}))

    return {
        "version": EVIDENCE_VERSION,
        "kind": EVIDENCE_KIND,
        "generated_at": _z(now),
        "today": today.isoformat(),
        "since": _iso(since) if since else None,
        "tz": "utc" if tz == timezone.utc else "local",
        "inputs": {
            "attempts": len({r.attempt_id for r in window}),
            "runs": len(window),
            "counted_runs": len(counted),
            "fun_runs": sum(1 for r in window if runs_mod.FUN_TAG in r.tags),
            "autoplay_runs": sum(1 for r in window if r.autoplay),
            "reports": len(window_reports),
            "skipped": skipped,
            "sessions": len(window_sessions),
        },
        "sessions": _sessions_block(window_sessions, all_attempts, all_reports),
        "warnings": warnings,
        "pending_analysis": pending,
        "plans": {
            pid: {"runs": len(rs), "drills": sorted({r.drill_id for r in rs if r.drill_id})}
            for pid, rs in plan_runs.items()
        },
        "drills": {did: _drill_entry(did, rs, tree, index, by_id) for did, rs in drill_runs.items()},
        "pieces": {sid: _piece_entry(sid, rs, by_id, window_reports) for sid, rs in piece_runs.items()},
        "score_notes": score_notes.evidence_block(scores_dir),
        "features": _features([r for r in counted if not (sight.is_sight(r.score_id) or ear.is_ear(r.score_id))], by_id),
        "nodes": gates.node_progress(tree, state, [r for r in all_runs if r.counted], today),
        "habits": habits.detect(habit_runs, habit_attempts, habit_reports, tree, state, keys),
    }


def _since_arg(text, tz):
    try:
        if len(text) == 10:
            return datetime.combine(date.fromisoformat(text), time(0), tzinfo=tz)
        return _parse_time(text, tz)
    except ValueError:
        return None


def _iso_date(text):
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise ValueError("must be a date as YYYY-MM-DD")


def add_evidence_parser(sub):
    p = sub.add_parser("evidence", help="aggregate saved attempts and reports for the coach (what /coach reads)")
    p.add_argument("--since", default=None, help="only look at runs from this YYYY-MM-DD (midnight) or ISO date-time")
    p.add_argument("--all", action="store_true", help="ignore last_review in state.json")
    p.add_argument("--today", default=None, help="treat this date (YYYY-MM-DD) as today")
    p.add_argument("--utc", action="store_true", help="use UTC dates instead of local time")
    p.add_argument("--json", action="store_true", help="print the evidence as JSON (version 1)")
    p.add_argument("--update-state", action="store_true", help="write the node progress into state.json")
    p.add_argument("--habit-days", type=int, default=14, help="days of history before --since that habit detection sees (default 14)")
    p.add_argument("--attempts-dir", default=None, help="folder of saved attempts (default: coach/data/attempts)")
    p.add_argument("--reports-dir", default=None, help="folder of analysis reports (default: coach/data/reports)")
    p.add_argument("--plan-dir", default=None, help="folder with tree.json and state.json (default: coach/data/plan)")
    p.add_argument("--sessions-dir", default=None, help="folder of recorded session .mid files (default: coach/data/sessions)")
    p.add_argument("--data-dir", default=None, help=DATA_DIR_HELP)
    return p


def _node_line(node_id, node):
    gates_ = node.get("gates") or {}

    def met(level):
        g = gates_.get(level)
        text = "met" if isinstance(g, dict) and g.get("met") else "not met"
        if isinstance(g, dict) and isinstance(g.get("drills_total"), int):
            text += f" ({g['drills_met']} of {g['drills_total']} drills)"
        return text

    return f"  {node_id}: max level {node.get('max_level')}, good {met('good')}, solid {met('solid')}"


def run_evidence(args) -> int:
    tz = timezone.utc if args.utc else LOCAL
    now = datetime.now(timezone.utc)
    try:
        today = _iso_date(args.today) if args.today else datetime.now(tz).date()
    except ValueError as e:
        print(f"error: --today {e}", file=sys.stderr if args.json else sys.stdout)
        return 1
    plan_dir = data_paths.plan_dir(args.plan_dir)
    since = None
    if args.since:
        since = _since_arg(args.since, tz)
        if since is None:
            print(
                "error: --since must be YYYY-MM-DD or an ISO date-time",
                file=sys.stderr if args.json else sys.stdout,
            )
            return 1
    elif not args.all:
        try:
            state = plan.load_json(plan_dir / plan.STATE_FILE)
            since = _parse_time(state.get("last_review"), tz)
        except (OSError, ValueError, AttributeError):
            since = None
    evidence = build_evidence(
        attempts_dir=data_paths.attempts_dir(args.attempts_dir),
        reports_dir=data_paths.reports_dir(args.reports_dir),
        plan_dir=plan_dir,
        scores_dir=resolve_data_dir(args.data_dir),
        since=since,
        today=today,
        tz=tz,
        now=now,
        habit_days=args.habit_days,
        sessions_dir=data_paths.sessions_dir(args.sessions_dir),
    )
    info = sys.stderr if args.json else sys.stdout
    state_path = plan_dir / plan.STATE_FILE
    if args.update_state:
        try:
            state = plan.load_json(state_path)
        except (OSError, ValueError):
            print("error: no state.json; run coach plan init first", file=info)
            return 1
        new = gates.apply_to_state(state, evidence["nodes"])
        new["updated_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        tmp = state_path.with_name(state_path.name + ".tmp")
        tmp.write_text(json.dumps(new, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, state_path)
    if args.json:
        print(json.dumps(evidence, indent=2, ensure_ascii=False))
    else:
        i = evidence["inputs"]
        print(f"Evidence since {evidence['since'] or 'the start'} (today {evidence['today']})")
        print(
            f"Runs: {i['counted_runs']} counted, {i['fun_runs']} fun, {i['autoplay_runs']} auto-play; "
            f"{i['reports']} reports; {len(evidence['pending_analysis'])} attempts need analysis"
        )
        s = evidence["sessions"]
        print(f"Sessions: {s['files']} recorded ({s['minutes']:g} min), {s['unanalysed_count']} not analysed")
        for node_id, node in evidence["nodes"].items():
            if node.get("runs"):
                print(_node_line(node_id, node))
        if evidence["habits"]:
            print("Habit candidates:")
            for h in evidence["habits"]:
                print(f"  {h.get('id')}: {h.get('title')}")
        else:
            print("Habit candidates: none")
    if args.update_state:
        print(f"Updated {state_path}", file=info)
    return 0
