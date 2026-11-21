"""coach fingering: make the fingering sidecars for the piano strip."""

import time

from .fingering_jobs import generate_for_row, textbook_scale
from .library import fingering, scale_fingering
from .library.cli import DATA_DIR_HELP
from .library.index import Library
from .library.paths import resolve_data_dir
from .library.sources import get_source
from .server import safe_file


def add_fingering_parser(sub) -> None:
    fp = sub.add_parser(
        "fingering",
        help="make fingering for the piano strip: textbook tables for scales, pianoplayer for other scores; "
        "skips scores that already have it",
    )
    fp.add_argument("--data-dir", default=None, help=DATA_DIR_HELP)
    group = fp.add_mutually_exclusive_group()
    group.add_argument("--id", default=None, help="one score: its id or #number")
    group.add_argument("--source", default=None, help="only scores from this source, e.g. pdmx, local, gen, scales")
    fp.add_argument("--force", action="store_true", help="make it again even if it is cached")


def run_fingering(args) -> int:
    data_dir = resolve_data_dir(args.data_dir)
    orphans, tmps = fingering.sweep_sidecars(data_dir)
    if orphans + tmps:
        print(f"Cleaned up {orphans + tmps} leftover fingering file(s)")
    made = cached = failed = 0
    with Library(data_dir) as lib:
        if args.id:
            try:
                rows = [lib.resolve(args.id)]
            except LookupError as e:
                print(f"error: {e}")
                return 1
        elif args.source:
            try:
                get_source(args.source)
            except LookupError as e:
                print(f"error: {e}")
                return 1
            rows = lib.search(None, downloaded=True, include_conflicts=True, source=args.source, limit=None)
        else:
            rows = lib.search(None, downloaded=True, include_conflicts=True, limit=None)
        for row in rows:
            path = safe_file(data_dir, row)
            if path is None:
                if args.id:
                    print(f"error: {row['id']} is not downloaded")
                    return 1
                continue
            label = f"#{row['num']} {row['title']} ({row['id']})"
            before = fingering.read_status(path)
            sc = textbook_scale(row)
            if sc is not None:
                if not args.force and before["status"] == "ready" and before["notes"] == scale_fingering.scale_notes(sc):
                    cached += 1
                else:
                    st = generate_for_row(row, path, force=True)
                    print(f"{label}: textbook ({len(st['notes'])} fingers)")
                    made += 1
                continue
            if not args.force and before["status"] == "ready":
                print(f"{label}: cached")
                cached += 1
            elif not args.force and before["status"] == "error" and not fingering.error_retry_due(path):
                print(
                    f"{label}: cached error: {before['error']} "
                    "(tried again after 7 days or a pianoplayer update; use --force to try now)"
                )
                cached += 1
            else:
                print(f"{label}: working...")
                t0 = time.perf_counter()
                st = generate_for_row(row, path, force=True)
                elapsed = time.perf_counter() - t0
                if st["status"] == "ready":
                    print(f"{label}: generated ({len(st['notes'])} fingers, {elapsed:.1f} s)")
                    made += 1
                else:
                    print(f"{label}: error: {st['error']}")
                    failed += 1
    print(f"Fingering: {made} made, {cached} cached, {failed} failed")
    return 1 if failed else 0
