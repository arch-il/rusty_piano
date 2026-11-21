import argparse
import sqlite3
import sys
from datetime import date

from . import data_paths, plan, practice_log, server
from .analyse_cli import add_analyse_parser, run_analyse
from .attempts_cli import add_attempts_parser, run_attempts
from .ear_cli import add_ear_parser, run_ear
from .fingering_cli import add_fingering_parser, run_fingering
from .library.cli import DATA_DIR_HELP, add_scores_parser, positive_int, run_scores
from .library.paths import resolve_data_dir
from .sight_cli import add_sight_parser, run_sight
from .trends import add_evidence_parser, run_evidence


def _iso_date(text: str) -> date:
    try:
        return date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be a date as YYYY-MM-DD")


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    parser = argparse.ArgumentParser(prog="coach", description="rusty_piano practice coach")
    sub = parser.add_subparsers(dest="command", required=True)
    add_scores_parser(sub)
    add_attempts_parser(sub)
    add_analyse_parser(sub)
    plan.add_plan_parser(sub)
    add_evidence_parser(sub)
    add_sight_parser(sub)
    add_ear_parser(sub)
    add_fingering_parser(sub)
    lg = sub.add_parser(
        "log", help="practice log: minutes per day, streak and pieces, from session .mid files and saved attempts"
    )
    lg.add_argument(
        "--sessions-dir",
        default=None,
        help="folder of recorded session .mid files (default: RUSTY_PIANO_DATA_DIR/sessions or coach/data/sessions)",
    )
    lg.add_argument(
        "--attempts-dir",
        default=None,
        help="folder for saved follower attempts (default: RUSTY_PIANO_DATA_DIR/attempts or coach/data/attempts)",
    )
    lg.add_argument("--days", type=positive_int, default=14, help="days shown in the window (default 14)")
    lg.add_argument("--today", type=_iso_date, default=None, help="treat this date (YYYY-MM-DD) as today")
    lg.add_argument("--utc", action="store_true", help="use UTC dates instead of local time")
    lg.add_argument("--json", action="store_true", help="print the log as JSON (version 1)")
    sp = sub.add_parser(
        "serve", help="serve the library and its sources to the sheet music page on http://127.0.0.1:PORT"
    )
    sp.add_argument("--data-dir", default=None, help=DATA_DIR_HELP)
    sp.add_argument(
        "--port",
        type=int,
        default=server.DEFAULT_PORT,
        help="port to listen on (default 8765; if you change it, change the proxy in web/vite.config.ts too)",
    )
    sp.add_argument(
        "--attempts-dir",
        default=None,
        help="folder for saved follower attempts (default: RUSTY_PIANO_DATA_DIR/attempts or coach/data/attempts)",
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "scores":
            return run_scores(args)
        if args.command == "attempts":
            return run_attempts(args)
        if args.command == "analyse":
            return run_analyse(args)
        if args.command == "plan":
            return plan.run_plan(args)
        if args.command == "evidence":
            return run_evidence(args)
        if args.command == "sight":
            return run_sight(args)
        if args.command == "ear":
            return run_ear(args)
        if args.command == "log":
            return practice_log.run_log(args)
        if args.command == "fingering":
            return run_fingering(args)
        if args.command == "serve":
            return server.serve(
                resolve_data_dir(args.data_dir),
                args.port,
                attempts_dir=data_paths.attempts_dir(args.attempts_dir),
            )
    except sqlite3.OperationalError:
        raise
    except sqlite3.DatabaseError as e:
        print(
            f"error: the score library file library.sqlite is damaged ({e}); move it out of the scores folder "
            "and run `coach scores sync gen` and `coach scores sync scales` to rebuild it",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
