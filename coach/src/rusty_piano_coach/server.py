"""Local web server for the sheet music page (coach serve): reads the library, saves follower attempts, serves the read-only practice log (GET /api/log), read-only replay data (GET /api/replay/...), reports and starts piano-strip fingering (GET/POST /api/scores/<id>/fingering), and score notes (GET/POST /api/scores/<id>/notes), and accepts guarded POSTs to download scores, remove scores and run source setup steps. Every request needs a local Host header; POSTs also need an Origin from a known page port."""

import argparse
import json
import os
import re
import sqlite3
import sys
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

from . import attempts, data_paths, ear, plan, practice_log, replay, sight
from .fingering_jobs import FingeringWorker, generate_for_row, textbook_scale
from .jobs import Busy, Jobs
from .library import sources as library_sources
from .library.busy import BUSY_LOCK_NAME
from .library.cli import parse_difficulty
from .library.fingering import error_retry_due, read_status, sweep_sidecars
from .library import score_notes
from .library.index import Library

DEFAULT_PORT = 8765
SOURCE_RESULT_LIMIT = 50
LIST_HIDDEN_SOURCES = ("scales",)  # shown only when the search box has text, so 972 generated scales don't crowd out the user's own pieces
MIN_SOURCE_QUERY = 2
LOG_DEFAULT_DAYS = 30
LOG_MAX_DAYS = 366
MAX_BODY = 1_000_000
MAX_ATTEMPT_BODY = 20_000_000
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")
DEV_ORIGIN_PORTS = (5173, 4173)  # npm run dev and npm run preview; must match server.port and preview.port in web/vite.config.ts
_DEFAULT_JOBS = Jobs()
_DEFAULT_FINGERING = FingeringWorker()
_PENDING = {"status": "pending", "source": None, "notes": [], "error": None}


@dataclass
class Response:
    status: int
    content_type: str
    body: bytes


def safe_file(data_dir: Path, row: dict) -> Path | None:
    if not row["file_path"]:
        return None
    full = (Path(data_dir) / row["file_path"]).resolve()
    root = (Path(data_dir) / "files").resolve()
    if full.is_relative_to(root) and full.is_file():
        return full
    return None


def score_json(row: dict, data_dir: Path) -> dict:
    file_path = row["file_path"] or ""
    piano = row["piano_only"]
    return {
        "id": row["id"],
        "num": row["num"],
        "title": row["title"],
        "composer": row["composer"],
        "artist": row["artist"],
        "difficulty": row["difficulty"],
        "key": row["key"],
        "time": row["time_signature"],
        "seconds": row["seconds"],
        "piano_only": None if piano is None else bool(piano),
        "source": row["source"],
        "attribution": row["attribution"],
        "license": row["license"],
        "license_url": row["license_url"],
        "format": "mxl" if file_path.lower().endswith(".mxl") else "musicxml",
        "has_file": safe_file(data_dir, row) is not None,
        "file_url": "/api/scores/" + quote(row["id"], safe="") + "/file",
    }


def facets(lib: Library) -> dict:
    def distinct(sql: str) -> list:
        return [r[0] for r in lib.conn.execute(sql).fetchall()]

    return {
        "keys": distinct(
            "SELECT DISTINCT key FROM scores WHERE file_path IS NOT NULL AND key IS NOT NULL "
            "ORDER BY key COLLATE NOCASE"
        ),
        "times": distinct(
            "SELECT DISTINCT time_signature FROM scores WHERE file_path IS NOT NULL "
            "AND time_signature IS NOT NULL ORDER BY time_signature"
        ),
        "difficulties": distinct(
            "SELECT DISTINCT difficulty FROM scores WHERE file_path IS NOT NULL "
            "AND difficulty IS NOT NULL ORDER BY difficulty"
        ),
    }


def _json(status: int, obj) -> Response:
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    return Response(status, "application/json; charset=utf-8", body)


def body_limit(raw_path: str) -> int:
    if urlsplit(raw_path).path == "/api/attempts":
        return MAX_ATTEMPT_BODY
    return MAX_BODY


def _arg(query: dict, name: str) -> str:
    values = query.get(name)
    return values[0].strip() if values else ""


def _env_ports() -> set:
    ports = set()
    for item in os.environ.get("RUSTY_PIANO_ORIGIN_PORTS", "").split(","):
        try:
            ports.add(int(item.strip()))
        except ValueError:
            pass
    return ports


def origin_allowed(origin, port: int = DEFAULT_PORT) -> bool:
    if not origin:
        return True
    try:
        parts = urlsplit(origin)
        return (
            parts.scheme in ("http", "https")
            and parts.hostname in _LOCAL_HOSTS
            and parts.port is not None
            and parts.port in {port, *DEV_ORIGIN_PORTS, *_env_ports()}
        )
    except ValueError:
        return False


def host_allowed(host) -> bool:
    if not host:
        return False
    try:
        return urlsplit("//" + host).hostname in _LOCAL_HOSTS
    except ValueError:
        return False


def source_json(src, lib, jobs, error=None) -> dict:
    running = jobs.running()
    try:
        steps = [
            {
                "id": st.id,
                "title": st.title,
                "detail": st.detail,
                "needed_for": st.needed_for,
                "done": st.done,
                "running": bool(
                    running
                    and running["kind"] == "setup"
                    and running["source"] == src.name
                    and running["target"] == st.id
                ),
            }
            for st in src.setup_steps(lib)
        ]
        ready = all(st["done"] for st in steps)
    except Exception as e:
        steps, ready, error = [], False, f"setup check failed: {e}"
    return {
        "name": src.name,
        "label": src.label or src.name,
        "description": src.description,
        "steps": steps,
        "ready": ready,
        "error": error,
    }


def _list_scores(data_dir: Path, query: dict, jobs: Jobs) -> Response:
    q = _arg(query, "q")
    key = _arg(query, "key")
    time = _arg(query, "time")
    difficulty_text = _arg(query, "difficulty")
    try:
        difficulty = parse_difficulty(difficulty_text) if difficulty_text else None
    except argparse.ArgumentTypeError as e:
        return _json(400, {"error": str(e)})
    limit_text = _arg(query, "limit")
    try:
        limit = int(limit_text) if limit_text else 500
    except ValueError:
        limit = 0
    if not 1 <= limit <= 1000:
        return _json(400, {"error": "limit must be a number from 1 to 1000"})
    with Library(data_dir) as lib:
        rows = lib.search(
            q or None,
            difficulty=difficulty,
            key=key or None,
            time_signature=time or None,
            downloaded=True,
            include_conflicts=True,
            order="title" if not q else "relevance",
            limit=limit if q else None,
        )
        capped = bool(q) and len(rows) == limit
        hidden = 0
        if not q:
            hidden = sum(1 for r in rows if r["source"] in LIST_HIDDEN_SOURCES and safe_file(data_dir, r) is not None)
            rows = [r for r in rows if r["source"] not in LIST_HIDDEN_SOURCES]
            total = sum(1 for r in rows if safe_file(data_dir, r) is not None)
            rows = rows[:limit]
        scores = [score_json(r, data_dir) for r in rows if safe_file(data_dir, r) is not None]
        if q:
            everything = lib.search(None, downloaded=True, include_conflicts=True, limit=None)
            total = sum(1 for r in everything if safe_file(data_dir, r) is not None)
        errors = {}
        all_src = library_sources.all_sources()
        if sum(len(t) for t in re.findall(r"\w+", q)) >= MIN_SOURCE_QUERY:
            seen = {sc["id"] for sc in scores}
            for src in all_src.values():
                try:
                    found = src.search(
                        lib,
                        q,
                        difficulty=difficulty,
                        key=key or None,
                        time_signature=time or None,
                        limit=SOURCE_RESULT_LIMIT,
                    )
                except Exception as e:
                    errors[src.name] = f"search failed: {e}"
                    continue
                for r in found:
                    if r["id"] in seen:
                        continue
                    item = score_json(r, data_dir)
                    if item["has_file"]:
                        continue
                    seen.add(r["id"])
                    scores.append(item)
        sources = [source_json(src, lib, jobs, errors.get(src.name)) for src in all_src.values()]
        return _json(200, {"scores": scores, "total": total, "facets": facets(lib), "sources": sources, "capped": capped, "hidden": hidden})


def _download(data_dir: Path, score_id: str, jobs: Jobs) -> Response:
    with Library(data_dir) as lib:
        row = lib.get(score_id)
        if row is None:
            return _json(404, {"error": "no such score"})
        if safe_file(data_dir, row) is not None:
            return _json(409, {"error": "already in your library"})
        src = library_sources.all_sources().get(row["source"])
        if src is None:
            return _json(404, {"error": "unknown source"})
        label = src.label or src.name
        missing = [st.title for st in src.setup_steps(lib) if not st.done]
        if missing:
            return _json(409, {"error": f"Set up {label} first: {', '.join(missing)}"})
        title = row["title"] or score_id

    def work(progress):
        with Library(data_dir) as wlib:
            added = src.download(wlib, [score_id], progress=progress)
        if score_id not in added:
            raise ValueError(f"{label} could not download this score (it is not in the archive or could not be read).")
        return f"Downloaded {title}"

    try:
        job = jobs.start(kind="download", source=src.name, target=score_id, label=f"Download {title}", work=work)
    except Busy as busy:
        return _json(409, {"error": str(busy)})
    return _json(202, {"job": job})


def _setup(data_dir: Path, name: str, step_id: str, jobs: Jobs) -> Response:
    src = library_sources.all_sources().get(name)
    if src is None:
        return _json(404, {"error": "unknown source"})
    with Library(data_dir) as lib:
        step = next((st for st in src.setup_steps(lib) if st.id == step_id), None)
    if step is None:
        return _json(404, {"error": "no such setup step"})
    if step.done:
        return _json(409, {"error": "already done"})

    def work(progress):
        with Library(data_dir) as wlib:
            return src.run_setup_step(wlib, step_id, progress)

    try:
        job = jobs.start(
            kind="setup", source=name, target=step_id, label=f"{src.label or src.name}: {step.title}", work=work
        )
    except Busy as busy:
        return _json(409, {"error": str(busy)})
    return _json(202, {"job": job})


def _remove(data_dir: Path, score_id: str, jobs: Jobs) -> Response:
    with Library(data_dir) as lib:
        row = lib.get(score_id)
        if row is None:
            return _json(404, {"error": "no such score"})
        if not row["file_path"]:
            return _json(409, {"error": "This score is not in your library."})
        src = library_sources.all_sources().get(row["source"])
        if src is None:
            return _json(404, {"error": "unknown source"})
        title = row["title"] or score_id
        try:
            with jobs.idle():
                src.remove(lib, score_id)
        except Busy as busy:
            return _json(409, {"error": str(busy)})
        except LookupError:
            return _json(404, {"error": "no such score"})
        except ValueError as e:
            return _json(409, {"error": str(e)})
        except OSError as e:
            return _json(500, {"error": f"Could not remove the score file: {e}"})
        return _json(
            200,
            {"removed": score_id, "kept_in_catalogue": bool(src.keeps_catalogue_row), "message": f"Removed {title}"},
        )


def _detail(data_dir: Path, score_id: str) -> Response:
    with Library(data_dir) as lib:
        row = lib.get(score_id)
    if row is None or not row["file_path"]:
        return _json(404, {"error": "no such score in your library"})
    return _json(200, score_json(row, data_dir))


def _fingering_path(data_dir: Path, score_id: str):
    with Library(data_dir) as lib:
        row = lib.get(score_id)
    path = safe_file(data_dir, row) if row else None
    return row, path


def _fingering_get(data_dir: Path, score_id: str, worker) -> Response:
    row, path = _fingering_path(data_dir, score_id)
    if path is None:
        return _json(404, {"error": "score file not found"})
    if worker.is_pending(path):
        return _json(200, _PENDING)
    return _json(200, read_status(path))


def _fingering_post(data_dir: Path, score_id: str, worker) -> Response:
    row, path = _fingering_path(data_dir, score_id)
    if path is None:
        return _json(404, {"error": "score file not found"})
    if textbook_scale(row):
        return _json(200, generate_for_row(row, path))
    st = read_status(path)
    if st["status"] == "ready" or (st["status"] == "error" and not error_retry_due(path)):
        return _json(200, st)
    if worker.is_pending(path):
        return _json(202, _PENDING)
    worker.request(path)
    return _json(202, _PENDING)


def _notes(data_dir: Path, score_id: str, method: str, body: bytes = b"", headers=None) -> Response:
    row, path = _fingering_path(data_dir, score_id)
    if method == "POST":
        status, obj = score_notes.handle_post(path, body, (headers or {}).get("Content-Type"))
    else:
        status, obj = score_notes.handle_get(path)
    return _json(status, obj)


def _file(data_dir: Path, score_id: str) -> Response:
    with Library(data_dir) as lib:
        row = lib.get(score_id)
    path = safe_file(data_dir, row) if row else None
    if path is None:
        return _json(404, {"error": "score file not found"})
    if path.suffix.lower() == ".mxl":
        content_type = "application/vnd.recordare.musicxml"
    else:
        content_type = "application/vnd.recordare.musicxml+xml"
    return Response(200, content_type, path.read_bytes())


def _post_attempt(body: bytes, headers: dict, attempts_dir: Path) -> Response:
    content_type = (headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if content_type != "application/json":
        return _json(415, {"error": "send the attempt as application/json"})
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return _json(400, {"error": "attempt is not valid JSON"})
    try:
        stored = attempts.save_attempt(attempts_dir, obj)
    except ValueError as e:
        return _json(400, {"error": str(e)})
    except OSError as e:
        return _json(500, {"error": f"could not save the attempt: {e}"})
    return _json(201, {"id": stored["id"], "file": stored["id"] + ".json"})


def _plan(plan_dir: Path) -> Response:
    tree_path = plan_dir / plan.TREE_FILE
    if not tree_path.exists():
        return _json(404, {"error": "No skill tree yet. Run /coach in Claude Code to set up your plan."})
    plan.migrate_tree(plan_dir)
    plan.migrate_technique(plan_dir)
    plan.migrate_skill_tree(plan_dir)
    try:
        tree = plan.load_json(tree_path)
    except ValueError as e:
        return _json(500, {"error": str(e)})
    problems = []
    state = None
    state_path = plan_dir / plan.STATE_FILE
    if state_path.exists():
        try:
            state = plan.load_json(state_path)
        except ValueError as e:
            state = None
            problems.append(str(e))
    errors, warnings = plan.check_plan(plan_dir)
    problems += errors + warnings
    problems = list(dict.fromkeys(problems))
    return _json(200, {"tree": tree, "state": state, "problems": problems})


def _log(sessions_dir: Path, attempts_dir: Path, query: dict) -> Response:
    text = _arg(query, "days")
    if not text:
        days = LOG_DEFAULT_DAYS
    elif not (text.isascii() and text.isdigit()) or not 1 <= int(text) <= LOG_MAX_DAYS:
        return _json(400, {"error": "days must be a number from 1 to 366"})
    else:
        days = int(text)
    try:
        log = practice_log.build_log(sessions_dir, attempts_dir, days=days)
    except OSError as e:
        return _json(500, {"error": f"could not read the practice log: {e}"})
    return _json(200, log)


def _sight_history(attempts_dir: Path, query: dict) -> Response:
    level = _arg(query, "level")
    if level and not re.fullmatch(sight.LEVEL_RE, level):
        return _json(400, {"error": "level must be a short lowercase id like r2-treble"})
    try:
        return _json(200, sight.history(attempts_dir, level or None))
    except OSError as e:
        return _json(500, {"error": f"could not read attempts: {e}"})


def _ear_history(attempts_dir: Path, query: dict) -> Response:
    level = _arg(query, "level")
    if level and not re.fullmatch(ear.LEVEL_RE, level):
        return _json(400, {"error": "level must be a short lowercase id like echo-1"})
    try:
        return _json(200, ear.history(attempts_dir, level or None))
    except OSError as e:
        return _json(500, {"error": f"could not read attempts: {e}"})


def _route(
    data_dir: Path,
    raw_path: str,
    method: str,
    headers: dict,
    jobs: Jobs,
    port: int = DEFAULT_PORT,
    body: bytes = b"",
    attempts_dir: Path | None = None,
    plan_dir: Path | None = None,
    sessions_dir: Path | None = None,
    fingering=None,
) -> Response:
    parts = urlsplit(raw_path)
    segments = [unquote(s) for s in parts.path.split("/")]
    is_download = len(segments) == 5 and segments[:3] == ["", "api", "scores"] and segments[4] == "download"
    is_setup = len(segments) == 6 and segments[:3] == ["", "api", "sources"] and segments[4] == "setup"
    is_remove = len(segments) == 5 and segments[:3] == ["", "api", "scores"] and segments[4] == "delete"
    is_attempts = segments == ["", "api", "attempts"]
    is_fingering = len(segments) == 5 and segments[:3] == ["", "api", "scores"] and segments[4] == "fingering"
    is_notes = len(segments) == 5 and segments[:3] == ["", "api", "scores"] and segments[4] == "notes"
    if not host_allowed(headers.get("Host")):
        return _json(403, {"error": "cross-site request refused"})
    if method == "POST":
        if not origin_allowed(headers.get("Origin"), port):
            return _json(
                403,
                {
                    "error": "cross-site request refused",
                    "hint": "open the page from npm run dev (port 5173) or npm run preview (4173), "
                    "or set RUSTY_PIANO_ORIGIN_PORTS",
                },
            )
        if is_attempts:
            return _post_attempt(body, headers, attempts_dir)
        if is_remove:
            return _remove(data_dir, segments[3], jobs)
        if is_download:
            return _download(data_dir, segments[3], jobs)
        if is_setup:
            return _setup(data_dir, segments[3], segments[5], jobs)
        if is_fingering:
            return _fingering_post(data_dir, segments[3], fingering)
        if is_notes:
            return _notes(data_dir, segments[3], "POST", body, headers)
        return _json(404, {"error": "not found"})
    if method != "GET":
        return _json(404, {"error": "not found"})
    if is_download or is_setup or is_remove or is_attempts:
        return _json(405, {"error": "use POST for this"})
    if is_fingering:
        return _fingering_get(data_dir, segments[3], fingering)
    if is_notes:
        return _notes(data_dir, segments[3], "GET")
    if segments == ["", "api", "jobs", "current"]:
        return _json(200, {"job": jobs.current()})
    if segments == ["", "api", "plan"]:
        return _plan(plan_dir)
    if segments == ["", "api", "log"]:
        return _log(sessions_dir, attempts_dir, parse_qs(parts.query))
    if len(segments) >= 4 and segments[:3] == ["", "api", "replay"]:
        status, obj = replay.handle(
            segments[3:], parse_qs(parts.query), data_dir=data_dir, attempts_dir=attempts_dir, sessions_dir=sessions_dir
        )
        return _json(status, obj)
    if segments == ["", "api", "sight", "history"]:
        return _sight_history(attempts_dir, parse_qs(parts.query))
    if segments == ["", "api", "ear", "history"]:
        return _ear_history(attempts_dir, parse_qs(parts.query))
    if segments == ["", "api", "scores"]:
        return _list_scores(data_dir, parse_qs(parts.query), jobs)
    if len(segments) == 4 and segments[:3] == ["", "api", "scores"]:
        return _detail(data_dir, segments[3])
    if len(segments) == 5 and segments[:3] == ["", "api", "scores"] and segments[4] == "file":
        return _file(data_dir, segments[3])
    return _json(404, {"error": "not found"})


def handle_request(
    data_dir: Path,
    raw_path: str,
    method: str = "GET",
    headers=None,
    jobs=None,
    port: int = DEFAULT_PORT,
    body: bytes = b"",
    attempts_dir=None,
    plan_dir=None,
    sessions_dir=None,
    fingering=None,
) -> Response:
    """headers=None means an in-process call (the tests) and is treated as {"Host": "127.0.0.1"}."""
    if headers is None:
        headers = {"Host": "127.0.0.1"}
    try:
        return _route(
            Path(data_dir),
            raw_path,
            method,
            headers,
            jobs or _DEFAULT_JOBS,
            port,
            body,
            data_paths.attempts_dir(attempts_dir),
            data_paths.plan_dir(plan_dir),
            sessions_dir=data_paths.sessions_dir(sessions_dir),
            fingering=fingering or _DEFAULT_FINGERING,
        )
    except sqlite3.Error:
        return _json(500, {"error": "library index problem"})
    except Exception:
        return _json(500, {"error": "internal error"})


class _Handler(BaseHTTPRequestHandler):
    def _respond(self, response: Response):
        self.send_response(response.status)
        self.send_header("Content-Type", response.content_type)
        self.send_header("Content-Length", str(len(response.body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(response.body)

    def _headers(self) -> dict:
        return {
            "Origin": self.headers.get("Origin"),
            "Host": self.headers.get("Host"),
            "Content-Type": self.headers.get("Content-Type"),
        }

    def do_GET(self):
        self._respond(
            handle_request(
                self.server.data_dir,
                self.path,
                "GET",
                self._headers(),
                self.server.jobs,
                port=self.server.server_address[1],
                plan_dir=self.server.plan_dir,
                attempts_dir=self.server.attempts_dir,
                sessions_dir=self.server.sessions_dir,
                fingering=self.server.fingering,
            )
        )

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > body_limit(self.path):
            self.close_connection = True
            self._respond(_json(413, {"error": "request body too large"}))
            return
        body = self.rfile.read(length) if length > 0 else b""
        self._respond(
            handle_request(
                self.server.data_dir,
                self.path,
                "POST",
                self._headers(),
                self.server.jobs,
                port=self.server.server_address[1],
                body=body,
                attempts_dir=self.server.attempts_dir,
                fingering=self.server.fingering,
            )
        )


class _Server(ThreadingHTTPServer):
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


def make_server(data_dir: Path, port: int = DEFAULT_PORT, attempts_dir=None, plan_dir=None, sessions_dir=None) -> _Server:
    server = _Server(("127.0.0.1", port), _Handler)
    server.data_dir = Path(data_dir)
    server.jobs = Jobs(lock_path=Path(data_dir) / BUSY_LOCK_NAME)
    server.fingering = FingeringWorker()
    server.attempts_dir = Path(attempts_dir) if attempts_dir else data_paths.attempts_dir()
    server.plan_dir = Path(plan_dir) if plan_dir else data_paths.plan_dir()
    server.sessions_dir = Path(sessions_dir) if sessions_dir else data_paths.sessions_dir()
    return server


def serve(data_dir: Path, port: int = DEFAULT_PORT, attempts_dir=None, plan_dir=None, sessions_dir=None) -> int:
    try:
        server = make_server(data_dir, port, attempts_dir, plan_dir, sessions_dir)
    except OSError as e:
        print(
            f"error: cannot listen on 127.0.0.1:{port} ({e}); is coach serve already running? Try --port.",
            file=sys.stderr,
        )
        return 1
    try:
        print(f"Serving the score library in {data_dir} at http://127.0.0.1:{server.server_address[1]} (API under /api).")
        print("Start the page in coach/web with: npm run dev, then open http://localhost:5173")
        print(
            f"POSTs are accepted from pages on ports 5173, 4173 and {server.server_address[1]} "
            "(plus any extra ports in RUSTY_PIANO_ORIGIN_PORTS)."
        )
        print(f"Saving follower attempts to {server.attempts_dir}")
        print(f"Reading the practice plan from {server.plan_dir}")
        print(f"Reading the practice log from {server.sessions_dir} and {server.attempts_dir}")
        print("Press Ctrl+C to stop.")
        # Opening the library here converts an existing database to WAL before any request.
        with Library(data_dir) as lib:
            if not lib.search(downloaded=True, include_conflicts=True, limit=1):
                print("Your library is empty; add scores with: uv run coach scores import <file or folder>")
        orphans, tmps = sweep_sidecars(data_dir)
        if orphans + tmps:
            print(f"Cleaned up {orphans + tmps} leftover fingering file(s)")
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.")
    finally:
        server.server_close()
    return 0
