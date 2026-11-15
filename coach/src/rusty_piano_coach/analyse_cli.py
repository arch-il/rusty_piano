import argparse
import json
import math
import sys
from datetime import timezone
from pathlib import Path

from . import attempts, compare, data_paths, reports, sessions, timing
from .library.cli import DATA_DIR_HELP, positive_int
from .library.index import Library
from .library.paths import library_file, resolve_data_dir

NO_INPUT_MSG = "error: give a session .mid (or latest) or --attempt, not both and not neither"
NO_WINDOW_MSG = "error: --start-ms/--end-ms only work with a .mid"
NO_ATTEMPT_MATCH = "no session .mid matched this attempt by engine time; analysed the attempt's own events (page clock)"


def _bars_arg(text: str) -> tuple[int, int]:
    err = argparse.ArgumentTypeError("must be a bar number or a range like 3-8 (first not above last)")
    parts = text.split("-")
    try:
        if len(parts) == 1:
            a = b = int(parts[0])
        elif len(parts) == 2:
            a, b = int(parts[0]), int(parts[1])
        else:
            raise err
    except ValueError:
        raise err
    if a < 0 or b < 0 or a > b:
        raise err
    return (a, b)


def _non_negative_int(text) -> int:
    err = argparse.ArgumentTypeError("must be a whole number of 0 or more")
    try:
        value = int(text)
    except ValueError:
        raise err
    if value < 0:
        raise err
    return value


def add_analyse_parser(subparsers) -> None:
    p = subparsers.add_parser(
        "analyse", help="compare a recorded session .mid or a saved attempt with a score and write a report"
    )
    p.add_argument("midi", nargs="?", default=None, help="a session .mid path, or latest")
    p.add_argument("--attempt", default=None, help="attempt id, a unique prefix, latest, or a path to an attempt .json")
    p.add_argument("--score", default=None, help="library score: id, # number or a unique prefix")
    p.add_argument("--score-file", default=None, help="a MusicXML/.mxl file to compare with (no library needed)")
    p.add_argument("--hands", choices=["both", "right", "left"], default=None, help="which hands to expect")
    p.add_argument("--bars", type=_bars_arg, default=None, help="bar range A-B (or a single bar A)")
    p.add_argument("--from-bar", type=_non_negative_int, default=None, help="from bar N to the end, in play order")
    p.add_argument("--loops", type=positive_int, default=None, help="how many times the bars were played")
    p.add_argument("--start-ms", type=float, default=None, help="ignore session notes before this time (.mid only)")
    p.add_argument("--end-ms", type=float, default=None, help="ignore session notes after this time (.mid only)")
    p.add_argument("--chord-ms", type=float, default=40.0, help="notes closer than this count as one chord (default 40)")
    p.add_argument("--data-dir", default=None, help=DATA_DIR_HELP)
    p.add_argument("--sessions-dir", default=None, help="folder of session .mid files (default: coach/data/sessions)")
    p.add_argument("--attempts-dir", default=None, help="folder of saved attempts (default: coach/data/attempts)")
    p.add_argument("--reports-dir", default=None, help="folder for reports (default: coach/data/reports)")
    p.add_argument("--json", action="store_true", help="print the report JSON only")


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_analyse(args) -> int:
    if bool(args.midi) == bool(args.attempt):
        print(NO_INPUT_MSG, file=sys.stderr)
        return 2
    if args.attempt and (args.start_ms is not None or args.end_ms is not None):
        print(NO_WINDOW_MSG, file=sys.stderr)
        return 2
    if not args.attempt and not args.score and not args.score_file:
        print("error: give --score or --score-file", file=sys.stderr)
        return 2
    try:
        return _run(args)
    except (LookupError, ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


def loop_speeds_of(practice: dict, loops: int) -> list[float] | None:
    tempo = practice.get("tempo") or {}
    ramp = tempo.get("ramp")
    percents = loop_percents_of(practice, loops)
    if not ramp or percents is None:
        return None
    start = percents[0]
    return [p / start for p in percents]


def loop_percents_of(practice: dict, loops: int) -> list[float] | None:
    tempo = practice.get("tempo") or {}
    ramp = tempo.get("ramp")
    if not ramp:
        return None
    by_cycle = {
        c.get("cycle"): c.get("percent")
        for c in ramp.get("cycles") or []
        if isinstance(c, dict) and isinstance(c.get("percent"), (int, float)) and c.get("percent") > 0
    }
    start = tempo.get("percent")
    percents = [start if isinstance(start, (int, float)) and start > 0 else 100]
    for c in range(2, loops + 1):
        percents.append(by_cycle.get(c, percents[-1]))
    return percents


def _run(args) -> int:
    extra_warnings: list[str] = []
    attempt_summary = None
    attempt_timing = None
    timing_curve = None
    score_text = args.score
    from_bar_to_end = False
    loop_speeds = None
    loop_percents = None
    bars = args.bars
    if args.from_bar is not None and bars is None:
        bars = (args.from_bar, args.from_bar)
        from_bar_to_end = True
    if args.attempt:
        attempt, attempt_path = attempts.load_attempt_file(data_paths.attempts_dir(args.attempts_dir), args.attempt)
        name = attempt_path.name
        try:
            practice = attempt["practice"]
            hands = args.hands or practice["hands"]
            rng = practice["range"]
            loops = args.loops or ((practice["loops_completed"] + 1) if practice["loop"] else 1)
            if practice["loop"]:
                loop_speeds = loop_speeds_of(practice, loops)
                loop_percents = loop_percents_of(practice, loops)
            if bars is None and rng:
                bars = (rng["from"], rng["to"])
                from_bar_to_end = rng["from"] == rng["to"] and not practice["loop"]
            match = sessions.find_session_for_attempt(attempt, data_paths.sessions_dir(args.sessions_dir))
            if match:
                full = sessions.read_midi(match.path)
                session = sessions.window(full, match.start_ms - 5.0, match.end_ms + 5.0)
                input_info = {
                    "kind": "attempt",
                    "midi_path": str(match.path),
                    "attempt_id": attempt["id"],
                    "session_started_at": _iso(full.started_at),
                    "window_ms": {"start": match.start_ms, "end": match.end_ms},
                    "time_base": "midi",
                }
            else:
                session = sessions.session_from_attempt_events(attempt)
                input_info = {
                    "kind": "attempt-events",
                    "midi_path": None,
                    "attempt_id": attempt["id"],
                    "session_started_at": None,
                    "window_ms": None,
                    "time_base": "page",
                }
                extra_warnings.append(NO_ATTEMPT_MATCH)
            attempt_summary = attempt["summary"].get("counts")
            timing_curve = timing.curve_of(attempt)
            attempt_timing = timing.attempt_timing(attempt)
            stem = attempt["id"]
            if not score_text and not args.score_file:
                score_text = attempt["score"]["id"]
        except KeyError as e:
            raise ValueError(f"{name} is missing {e.args[0]}") from None
        except (TypeError, AttributeError) as e:
            raise ValueError(f"{name} is not a complete attempt ({e})") from None
    else:
        path = sessions.resolve_session(args.midi, data_paths.sessions_dir(args.sessions_dir))
        session = sessions.read_midi(path)
        window_ms = None
        if args.start_ms is not None or args.end_ms is not None:
            start = args.start_ms if args.start_ms is not None else -math.inf
            end = args.end_ms if args.end_ms is not None else math.inf
            session = sessions.window(session, start, end)
            window_ms = {"start": args.start_ms, "end": args.end_ms}
        input_info = {
            "kind": "midi",
            "midi_path": str(path),
            "attempt_id": None,
            "session_started_at": _iso(session.started_at),
            "window_ms": window_ms,
            "time_base": "midi",
        }
        stem = path.stem
        hands = args.hands or "both"
        loops = args.loops or 1

    if args.score_file:
        path = Path(args.score_file)
        loaded = compare.load_score(path)
        score_info = {"id": None, "title": loaded.title or path.stem, "file": str(path)}
    else:
        data_dir = resolve_data_dir(args.data_dir)
        with Library(data_dir) as lib:
            row = lib.resolve(score_text)
        if not row["file_path"]:
            raise LookupError("this score is not downloaded")
        path = library_file(data_dir, row["file_path"])
        if not path.is_file():
            raise FileNotFoundError(f"no such file: {path}")
        loaded = compare.load_score(path)
        score_info = {"id": row["id"], "title": row["title"] or loaded.title, "file": str(path)}
    score_info["score_bpm"] = loaded.score_bpm
    score_info["time_signature"] = loaded.time_signature
    score_info["bars_written"] = loaded.bars_written

    expected, play_order, method = compare.expected_notes(
        loaded, hands=hands, bars=bars, loops=loops, from_bar_to_end=from_bar_to_end,
        loop_speeds=loop_speeds,
    )
    analysis = compare.analyse(expected, session.notes, chord_ms=args.chord_ms, timing_curve=timing_curve)
    options = {
        "hands": hands,
        "bars": {"from": bars[0], "to": bars[1]} if bars else None,
        "loops": loops,
        "loop_tempo_percents": loop_percents,
        "from_bar_to_end": from_bar_to_end,
        "chord_ms": args.chord_ms,
        "tempo_tolerance": 0.08,
        "free_ends": True,
    }
    expansion = {"method": method, "play_order": play_order, "warnings": loaded.warnings}
    report = reports.build_report(
        analysis,
        input_info=input_info,
        score_info=score_info,
        options=options,
        expansion=expansion,
        attempt_summary=attempt_summary,
        attempt_timing=attempt_timing,
        extra_warnings=extra_warnings,
        stem=stem,
    )
    json_path, md_path = reports.write_report(report, data_paths.reports_dir(args.reports_dir))
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    for line in reports.headline_lines(report):
        print(line)
    print(f"Report: {json_path}")
    print(f"Summary: {md_path}")
    return 0
