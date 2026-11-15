import argparse
import sqlite3
import sys
import tarfile
from pathlib import Path

from .busy import busy_lock
from .index import Library, fts_query
from .paths import resolve_data_dir
from .sources import UnsupportedCommand, all_sources, get_source

DATA_DIR_HELP = "library folder (default: RUSTY_PIANO_SCORES_DIR or coach/data/scores)"
EMPTY_INDEX_HINT = (
    "The library is empty. Load the PDMX catalogue with: coach scores sync pdmx, "
    "or add your own files with: coach scores import <file or folder>"
)
NO_DOWNLOADS_HINT = (
    "Download scores with: coach scores download <id> (find ids with: coach scores search), "
    "or import your own: coach scores import <file or folder>"
)
BUSY_MESSAGE = (
    "error: another coach process is using this library (coach serve is running a download or setup step, "
    "or another delete is running); wait for it to finish, then run delete again."
)


def positive_int(text) -> int:
    err = argparse.ArgumentTypeError("must be a whole number of 1 or more")
    try:
        value = int(text)
    except ValueError:
        raise err
    if value < 1:
        raise err
    return value


def parse_difficulty(text) -> tuple[int, int]:
    err = argparse.ArgumentTypeError("difficulty must be 1-5 or a range like 1-2")
    parts = str(text).strip().split("-")
    try:
        if len(parts) == 1:
            lo = hi = int(parts[0])
        elif len(parts) == 2:
            lo, hi = int(parts[0]), int(parts[1])
        else:
            raise err
    except ValueError:
        raise err
    if not (1 <= lo <= 5 and 1 <= hi <= 5) or lo > hi:
        raise err
    return lo, hi


def _dash(v):
    return "-" if v is None or v == "" else str(v)


def _mss(seconds):
    if seconds is None:
        return "-"
    s = int(round(seconds))
    return f"{s // 60}:{s % 60:02d}"


def _cut(text, n):
    text = _dash(text)
    return text if len(text) <= n else text[: n - 3] + "..."


def format_table(rows) -> str:
    header = ["#", "Title", "Composer", "Key", "Time", "Length", "Diff", "Source", "Have"]
    body = [
        [
            _dash(r["num"]),
            _cut(r["title"], 40),
            _cut(r["composer"] or r["artist"], 24),
            _dash(r["key"]),
            _dash(r["time_signature"]),
            _mss(r["seconds"]),
            _dash(r["difficulty"]),
            _dash(r["source"]),
            "yes" if r["file_path"] else "",
        ]
        for r in rows
    ]
    table = [header] + body
    widths = [max(len(row[i]) for row in table) for i in range(len(header))]
    return "\n".join("  ".join(c.ljust(w) for c, w in zip(row, widths)).rstrip() for row in table)


def _sources(lib, args):
    for s in all_sources().values():
        print(f"{s.name:8} {s.description}")
    return 0


def _sync(lib, args):
    get_source(args.source).sync(lib, args.from_file)
    return 0


def _fetch_archive(lib, args):
    get_source(args.source).fetch_archive(lib, args.from_file)
    return 0


def _download(lib, args):
    groups = {}
    rows = []
    for t in args.ids:
        row = lib.resolve(t)
        rows.append(row)
        groups.setdefault(row["source"], []).append(row["id"])
    for src, ids in groups.items():
        get_source(src).download(lib, ids)
    missing = []
    for row in rows:
        now = lib.get(row["id"])
        if not (now and now["file_path"] and (lib.data_dir / now["file_path"]).is_file()):
            missing.append(f"#{row['num']} {row['title']}")
    if missing:
        print(
            f"error: {len(missing)} of {len(rows)} score(s) were not downloaded: {', '.join(missing)}",
            file=sys.stderr,
        )
        return 1
    return 0


def _remove(lib, args):
    lock = busy_lock(lib.data_dir)
    if not lock.acquire():
        print(BUSY_MESSAGE, file=sys.stderr)
        return 1
    try:
        failed = 0
        for t in args.ids:
            try:
                row = lib.resolve(t)
            except LookupError as e:
                print(f"error: {e}", file=sys.stderr)
                failed += 1
                continue
            if not row["file_path"]:
                print(f"not in your library: #{row['num']} {row['title']}")
                continue
            src = get_source(row["source"])
            try:
                src.remove(lib, row["id"])
            except (OSError, ValueError, LookupError) as e:
                print(f"error: could not remove #{row['num']} {row['title']}: {e}", file=sys.stderr)
                failed += 1
                continue
            msg = f"removed #{row['num']} {row['title']}"
            if src.keeps_catalogue_row:
                msg += f" (still in {src.label or src.name} search)"
            print(msg)
        if failed:
            print(f"{failed} of {len(args.ids)} id(s) could not be removed.", file=sys.stderr)
            return 1
        return 0
    finally:
        lock.release()


def _import(lib, args):
    get_source("local").import_paths(lib, [Path(p) for p in args.paths])
    return 0


def _search(lib, args):
    if args.source:
        get_source(args.source)
    if args.text and fts_query(args.text) == "":
        print("No scores found.")
        print("Note: the search text has no letters or digits, so nothing can match.")
        return 0
    rows = lib.search(
        args.text,
        composer=args.composer,
        difficulty=args.difficulty,
        key=args.key,
        time_signature=args.time,
        max_seconds=args.max_seconds,
        piano=args.piano,
        downloaded=args.downloaded,
        source=args.source,
        include_conflicts=args.include_conflicts,
        limit=args.limit,
    )
    if not rows:
        print("No scores found.")
        if lib.count() == 0:
            print(EMPTY_INDEX_HINT)
        elif args.key or args.time:
            print("Note: key and time signature are only known for downloaded or imported scores; try --downloaded.")
        return 0
    print(format_table(rows))
    msg = f"{len(rows)} result(s)"
    if len(rows) == args.limit:
        msg += f" (limit {args.limit}; use --limit for more)"
    print(msg)
    return 0


def _list(lib, args):
    rows = lib.search(downloaded=True, include_conflicts=True, order="title", limit=args.limit)
    if rows:
        print(format_table(rows))
    print(f"{len(rows)} score(s) in your library ({lib.count():,} in the index)")
    if not rows:
        print(EMPTY_INDEX_HINT if lib.count() == 0 else NO_DOWNLOADS_HINT)
    return 0


def _yn(v):
    return "unknown" if v is None else ("yes" if v else "no")


def _licence(name, url):
    if name and url:
        return f"{name} ({url})"
    return name or url or "-"


def _show(lib, args):
    r = lib.resolve(args.id)
    d = f"{r['difficulty']} (from {r['difficulty_basis']})" if r["difficulty"] is not None else "unknown"
    rating = f"{r['rating']} ({r['n_ratings']} ratings)" if r["rating"] is not None else "-"
    lic = _licence(r["license"], r["license_url"])
    if r["file_path"]:
        file = str(lib.data_dir / r["file_path"])
    else:
        file = f"not downloaded (run: coach scores download {r['num']})"
    lines = [
        f"#{r['num']}  {r['id']}",
        f"Title: {_dash(r['title'])}",
        f"Composer: {_dash(r['composer'])}",
        f"Artist: {_dash(r['artist'])}",
        f"Source: {_dash(r['source'])}",
        f"Key: {_dash(r['key'])}",
        f"Time signature: {_dash(r['time_signature'])}",
        f"Length: {_mss(r['seconds'])}",
        f"Difficulty: {d}",
        f"Note count: {_dash(r['n_notes'])}",
        f"Piano only: {_yn(r['piano_only'])}",
        f"Tags: {_dash(r['tags'])}",
        f"Genres: {_dash(r['genres'])}",
        f"Rating: {rating}",
        f"License: {lic}",
        f"License conflict: {'yes' if r['license_conflict'] else 'no'}",
        f"Attribution: {_dash(r['attribution'])}",
        f"File: {file}",
    ]
    print("\n".join(lines))
    return 0


def add_scores_parser(subparsers):
    p = subparsers.add_parser(
        "scores", help="sheet music library: sync, download, import and search MusicXML scores"
    )
    p.add_argument("--data-dir", default=None, help=DATA_DIR_HELP)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data-dir", default=argparse.SUPPRESS, help=DATA_DIR_HELP)
    sub = p.add_subparsers(dest="scores_command", required=True)

    sub.add_parser("sources", parents=[common], help="list the score sources").set_defaults(func=_sources)

    source_help = "source name (see: coach scores sources)"
    from_help = "use a local copy of the file instead of downloading it"
    ids_help = "score ids: the # number, the full id (pdmx:<hash>, local:<sha16>) or a unique prefix"

    sp = sub.add_parser(
        "sync", parents=[common], help="load a source's catalogue into the index (pdmx: about 254k scores)"
    )
    sp.add_argument("source", help=source_help)
    sp.add_argument("--from", dest="from_file", type=Path, default=None, help=from_help)
    sp.set_defaults(func=_sync)

    sp = sub.add_parser(
        "fetch-archive", parents=[common], help="download a source's score archive (pdmx: 1.9 GB, one time)"
    )
    sp.add_argument("source", help=source_help)
    sp.add_argument("--from", dest="from_file", type=Path, default=None, help=from_help)
    sp.set_defaults(func=_fetch_archive)

    sp = sub.add_parser("download", parents=[common], help="download scores into your library")
    sp.add_argument("ids", nargs="+", metavar="ID", help=ids_help)
    sp.set_defaults(func=_download)

    sp = sub.add_parser(
        "delete",
        parents=[common],
        help="remove downloaded or imported scores from your library (PDMX scores stay searchable)",
    )
    sp.add_argument("ids", nargs="+", metavar="ID", help=ids_help)
    sp.set_defaults(func=_remove)

    sp = sub.add_parser(
        "import", parents=[common], help="import your own MusicXML files or folders (.musicxml, .xml, .mxl)"
    )
    sp.add_argument("paths", nargs="+", metavar="PATH", help="MusicXML files or folders to import")
    sp.set_defaults(func=_import)

    sp = sub.add_parser("search", parents=[common], help="search the index by text and filters")
    sp.add_argument(
        "text", nargs="?", default=None, help="words to find in title, composer, artist, tags and genres"
    )
    sp.add_argument("--composer", help="composer or artist contains this text")
    sp.add_argument("--difficulty", type=parse_difficulty, help="difficulty 1-5 or a range like 1-2")
    sp.add_argument("--key", help="key, e.g. 'C major' (only known for downloaded or imported scores)")
    sp.add_argument("--time", help="time signature, e.g. 3/4 (only known for downloaded or imported scores)")
    sp.add_argument("--max-seconds", type=float, help="longest length in seconds")
    sp.add_argument("--piano", action="store_true", help="only piano scores")
    sp.add_argument("--downloaded", action="store_true", help="only scores in your library")
    sp.add_argument("--source", help="only scores from this source (see: coach scores sources)")
    sp.add_argument("--include-conflicts", action="store_true", help="also show scores with a licence conflict")
    sp.add_argument("--limit", type=positive_int, default=20, help="most results to show (default 20)")
    sp.set_defaults(func=_search)

    sp = sub.add_parser("list", parents=[common], help="list the scores you have downloaded or imported")
    sp.add_argument("--limit", type=positive_int, default=None, help="most scores to show (default: all)")
    sp.set_defaults(func=_list)

    sp = sub.add_parser("show", parents=[common], help="details, licence and file of one score")
    sp.add_argument("id", help="score id: the # number, the full id or a unique prefix")
    sp.set_defaults(func=_show)

    return p


def run_scores(args) -> int:
    lib = Library(resolve_data_dir(args.data_dir))
    try:
        return args.func(lib, args)
    except (tarfile.TarError, EOFError) as e:
        print(
            f"error: PDMX archive is damaged ({e}); delete it and run: coach scores fetch-archive pdmx",
            file=sys.stderr,
        )
        return 1
    except sqlite3.Error as e:
        print(f"error: library index problem ({e})", file=sys.stderr)
        return 1
    except (LookupError, OSError, ValueError, UnsupportedCommand) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    finally:
        lib.close()
