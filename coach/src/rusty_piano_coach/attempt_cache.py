"""Cache of parsed attempts for coach evidence: <attempts_dir>/.cache/attempts-v1.json keeps each attempt without its events (plus its engine velocities), re-read only when the file's size or modification time changes."""

import gc
import json
import os
from pathlib import Path

from . import attempts as attempts_mod

CACHE_DIR = ".cache"
CACHE_FILE = "attempts-v1.json"
CACHE_VERSION = 1


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _velocities(events) -> list:
    return [
        e["velocity"]
        for e in events or []
        if e.get("type") == "note_on" and e.get("source") == "engine" and e.get("velocity") is not None
    ]


def _slim_step(step):
    if not isinstance(step, dict):
        return step
    out = {}
    for key, value in step.items():
        if key != "timing_score" and (value is None or value == []):
            continue
        if key == "played" and isinstance(value, list):
            value = [{k: p[k] for k in ("note", "page_ms") if k in p} if isinstance(p, dict) else p for p in value]
        elif key == "wrong" and isinstance(value, list):
            value = [{k: w[k] for k in ("note",) if k in w} if isinstance(w, dict) else w for w in value]
        elif key == "holds" and isinstance(value, list):
            value = [{k: h[k] for k in ("short",) if k in h} if isinstance(h, dict) else h for h in value]
        out[key] = value
    return out


def slim(obj: dict) -> dict:
    out = {k: v for k, v in obj.items() if k != "events"}
    if isinstance(out.get("steps"), list):
        out["steps"] = [_slim_step(s) for s in out["steps"]]
    out["_engine_velocities"] = _velocities(obj.get("events"))
    return out


def _load_cache(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if isinstance(data, dict) and data.get("version") == CACHE_VERSION and isinstance(data.get("files"), dict):
        return data["files"]
    return {}


def _write_cache(path: Path, files: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(
            json.dumps({"version": CACHE_VERSION, "files": files}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(tmp, path)
    except OSError:
        pass


def read_attempts(folder: Path) -> tuple[list[dict], list[str]]:
    if not folder.is_dir():
        return [], []
    cache_path = folder / CACHE_DIR / CACHE_FILE
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        old = _load_cache(cache_path)
    finally:
        if was_enabled:
            gc.enable()
    new = {}
    changed = False
    kept = []
    problems = []
    try:
        with os.scandir(folder) as it:
            found = sorted(
                (e for e in it if os.path.normcase(e.name).endswith(".json")), key=lambda e: e.name
            )
    except OSError:
        found = []
    for dirent in found:
        try:
            if not dirent.is_file():
                continue
            st = dirent.stat()
        except OSError as e:
            problems.append(f"{dirent.name}: unreadable ({e})")
            continue
        path = folder / dirent.name
        entry = old.get(path.name)
        if (
            isinstance(entry, dict)
            and isinstance(entry.get("attempt"), dict)
            and entry["attempt"].get("id") == path.stem
            and entry.get("size") == st.st_size
            and entry.get("mtime_ns") == st.st_mtime_ns
        ):
            kept.append(entry["attempt"])
            new[path.name] = entry
            continue
        try:
            obj = _read_json(path)
        except (OSError, ValueError) as e:
            problems.append(f"{path.name}: unreadable ({e})")
            continue
        if isinstance(obj, dict) and obj.get("version") in attempts_mod.READ_VERSIONS:
            s = slim(obj)
            kept.append(s)
            new[path.name] = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "attempt": s}
            changed = True
        else:
            problems.append(f"{path.name}: not a version 1 or 2 attempt")
    if changed or set(old) != set(new):
        _write_cache(cache_path, new)
    return kept, problems
