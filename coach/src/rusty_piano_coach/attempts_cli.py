import json
import sys
from collections import Counter
from datetime import datetime

from . import attempts, data_paths, timing
from .library.cli import positive_int

ATTEMPTS_DIR_HELP = "folder for saved follower attempts (default: RUSTY_PIANO_DATA_DIR/attempts or coach/data/attempts)"
ID_HELP = "attempt id, a unique prefix, latest, or a path to an attempt .json"
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
RESULTS = ("hit", "early", "late", "missed", "wrong", "short", "pending")
PROBLEM_LIMIT = 50


def add_attempts_parser(subparsers) -> None:
    p = subparsers.add_parser("attempts", help="saved follower attempts from the sheet music page: list and show")
    sub = p.add_subparsers(dest="attempts_command", required=True)
    lp = sub.add_parser("list", help="list saved attempts, newest first")
    lp.add_argument("--attempts-dir", default=None, help=ATTEMPTS_DIR_HELP)
    lp.add_argument("--limit", type=positive_int, default=None, help="show at most N attempts")
    lp.add_argument("--json", action="store_true", help="print JSON")
    sp = sub.add_parser("show", help="show one saved attempt")
    sp.add_argument("id", help=ID_HELP)
    sp.add_argument("--attempts-dir", default=None, help=ATTEMPTS_DIR_HELP)
    sp.add_argument("--json", action="store_true", help="print the stored attempt JSON")
    sp.add_argument("--all-steps", action="store_true", help="list every step, not only the ones that were not hits")


def run_attempts(args) -> int:
    folder = data_paths.attempts_dir(args.attempts_dir)
    if args.attempts_command == "list":
        return _list(args, folder)
    return _show(args, folder)


def note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def _cut(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 3] + "..."


def _local(started_at: str, fmt: str) -> str:
    return datetime.fromisoformat(started_at).astimezone().strftime(fmt)


def _duration(ms) -> str:
    seconds = round((ms or 0) / 1000)
    return f"{seconds // 60}:{seconds % 60:02d}"


def _bars(practice: dict) -> str:
    rng = practice.get("range")
    if rng is None:
        text = "All"
    elif rng["from"] == rng["to"]:
        text = str(rng["from"]) if practice.get("loop") else f"from {rng['from']}"
    else:
        text = f"{rng['from']}-{rng['to']}"
    return text + " loop" if practice.get("loop") else text


def _table(rows: list[list[str]]) -> str:
    widths = [max(len(row[i]) for row in rows) for i in range(len(rows[0]))]
    return "\n".join("  ".join(c.ljust(w) for c, w in zip(row, widths)).rstrip() for row in rows)


def _list(args, folder) -> int:
    found, problems = attempts.list_attempts(folder)
    for problem in problems:
        print(f"warning: skipped {problem}", file=sys.stderr)
    if not found:
        print(
            f"No attempts saved yet in {folder}. The page saves one when a run ends (Done or Stop) while coach serve is running."
        )
        return 0
    rows = []
    for a in found:
        try:
            metrics = a["summary"].get("metrics", {})
            row = {
                "id": a["id"],
                "started_at": a["started_at"],
                "mode": a["mode"],
                "end": a["end"],
                "score_id": a["score"]["id"],
                "title": a["score"].get("title"),
                "bars": a["practice"].get("range"),
                "hands": a["practice"]["hands"],
                "accuracy": metrics.get("accuracy"),
                "tempo": metrics.get("tempo"),
                "sources": a["sources"],
                "duration_ms": a.get("duration_ms"),
            }
            cells = [
                a["id"],
                _local(a["started_at"], "%Y-%m-%d %H:%M"),
                a["mode"],
                a["end"],
                _cut(a["score"].get("title") or a["score"]["id"], 40),
                _bars(a["practice"]),
                a["practice"]["hands"],
                str(metrics.get("accuracy") or "-"),
                str(metrics.get("tempo") or "-"),
                ",".join(a["sources"]),
            ]
            key = attempts.started_key(a)
        except (KeyError, TypeError, AttributeError, ValueError) as e:
            reason = f"missing {e.args[0]}" if isinstance(e, KeyError) else f"not a complete attempt ({e})"
            print(f"warning: skipped {a.get('id', '?') if isinstance(a, dict) else '?'}.json: {reason}", file=sys.stderr)
            continue
        rows.append((key, row, cells))
    rows.sort(key=lambda r: r[0], reverse=True)
    if args.limit is not None:
        rows = rows[: args.limit]
    if not rows:
        return 0
    if args.json:
        print(json.dumps([r[1] for r in rows], ensure_ascii=False, indent=2))
        return 0
    header = ["ID", "Started", "Mode", "End", "Score", "Bars", "Hands", "Acc", "Tempo", "Sources"]
    print(_table([header] + [r[2] for r in rows]))
    return 0


def _problem(step: dict, curve: dict | None = None) -> str:
    expected = " ".join(note_name(n) for n in step["expected"])
    line = f"  loop {step['cycle']} bar {step['bar']} beat {step['beat']:g} (pass {step['pass']}): {expected} -> {step['result']}"
    if step.get("offset_ms") is not None:
        line += f" ({step['offset_ms']:+.0f} ms)"
    score = timing.step_timing_score(step, curve)
    if score is not None:
        line += f" timing {score}"
    if step["wrong"]:
        line += " played " + " ".join(note_name(w["note"]) for w in step["wrong"])
    for hold in step["holds"]:
        if hold["short"]:
            line += f" held {hold['held_ms']} of {hold['expected_ms']:.0f} ms"
    return line


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_ms(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0


def _step_no(step: dict, key: str, index: int) -> int:
    value = step.get(key)
    return value + 1 if _is_int(value) else index + 1


def _names(notes) -> str:
    return " ".join(note_name(x) for x in notes if _is_int(x))


def _sight_problem(step: dict, index: int) -> str:
    n = _step_no(step, "card", index)
    line = f"  card {n}: {_names(step.get('notes') or []) or '-'} -> {step.get('result')}"
    played = _names(step.get("wrong_notes") or [])
    if played:
        line += " played " + played
    if step.get("hinted") is True:
        line += " (hinted)"
    if _is_ms(step.get("reaction_ms")):
        line += f" {step['reaction_ms'] / 1000:.1f} s"
    return line


def _ear_problem(step: dict, index: int) -> str:
    n = _step_no(step, "item", index)
    label = step["label"] if isinstance(step.get("label"), str) else _names(step.get("answer_notes") or []) or "-"
    line = f"  item {n}: {label} -> {step.get('result')}"
    played = _names(step.get("wrong_notes") or [])
    if played:
        line += " played " + played
    if step.get("revealed") is True:
        line += " (revealed)"
    replays = step.get("replays")
    if _is_int(replays) and replays > 0:
        line += f" replays {replays}"
    if _is_ms(step.get("response_ms")):
        line += f" {step['response_ms'] / 1000:.1f} s"
    return line


def _show(args, folder) -> int:
    try:
        a, path = attempts.load_attempt_file(folder, args.id)
    except (LookupError, ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(a, ensure_ascii=False, indent=2))
        return 0
    try:
        return _render(a, args)
    except (KeyError, TypeError, AttributeError, ValueError) as e:
        reason = f"is missing {e.args[0]}" if isinstance(e, KeyError) else f"is not a complete attempt ({e})"
        print(f"error: {path.name} {reason}", file=sys.stderr)
        return 1


def _render(a, args) -> int:
    practice = a["practice"]
    tempo = practice["tempo"]
    rows = a["summary"].get("rows", [])
    width = max((len(str(label)) for label, _ in rows), default=0)
    steps = a["steps"]
    counts = Counter(step["result"] for step in steps)
    curve = timing.curve_of(a)
    kind = str(a["score"]["id"]).split(":", 1)[0]
    if kind == "sight":
        problems = [_sight_problem(s, i) for i, s in enumerate(steps) if isinstance(s, dict) and (args.all_steps or s.get("first_try") is not True)]
    elif kind == "ear":
        problems = [_ear_problem(s, i) for i, s in enumerate(steps) if isinstance(s, dict) and (args.all_steps or s.get("first_try") is not True)]
    else:
        problems = [_problem(step, curve) for step in steps if args.all_steps or step["result"] != "hit"]
    overall = timing.attempt_timing(a)
    shown = problems if args.all_steps else problems[:PROBLEM_LIMIT]
    lines = [
        f"Attempt {a['id']}",
        f"Score: {a['score'].get('title') or '-'} ({a['score']['id']})",
        f"Started: {_local(a['started_at'], '%Y-%m-%d %H:%M')} · Duration {_duration(a.get('duration_ms'))} · End: {a['end']}",
        f"Mode: {a['mode']} · Hands: {practice['hands']} · Bars: {_bars(practice)} · Loops completed: {practice['loops_completed']}",
        f"Tempo: {tempo['percent']}% · start {tempo.get('start_bpm') or tempo.get('bpm') or '-'} bpm",
        f"Sources: {','.join(a['sources'])} · Pedal down at start: {'yes' if a['pedal_down_at_start'] else 'no'}",
        "Summary:",
    ]
    lines += [f"  {str(label).ljust(width)}  {value}" for label, value in rows]
    lines.append(f"Steps: {len(steps)} (" + ", ".join(f"{r} {counts[r]}" for r in RESULTS) + ")")
    if overall["timing_score"] is not None:
        lines.append(f"Timing score: {overall['timing_score']} of 100 ({overall['scored_steps']} steps)")
    if kind == "ear":
        ear = a.get("ear") or {}
        median = ear.get("median_step_ms")
        lines.append(
            f"Ear: level {ear.get('level', '-')} · first try {ear.get('first_try', '-')} of {ear.get('items_total', '-')}"
            f" · replays {ear.get('replays', '-')} · revealed {ear.get('revealed', '-')}"
            f" · median {'-' if median is None else f'{median / 1000:.1f} s'} per answer"
        )
    lines.append("Problems:")
    if not problems:
        lines.append("  none")
    lines += shown
    if len(problems) > len(shown):
        lines.append(f"  ... {len(problems) - len(shown)} more (use --all-steps)")
    print("\n".join(lines))
    return 0
