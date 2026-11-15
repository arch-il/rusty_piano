"""Score notes: hard bars, bar notes and a piece note in a <score>.notes.json sidecar next to the score."""

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SIDECAR_SUFFIX = ".notes.json"
NOTES_VERSION = 1
BAR_NOTE_MAX = 500
PIECE_NOTE_MAX = 2000
MAX_BAR = 9999
_LOCK = threading.Lock()
_BAR_KEY = re.compile(r"[1-9][0-9]{0,3}")
_BARS_MESSAGE = f"hard_bars must be a list of bar numbers from 1 to {MAX_BAR}"
_NOTES_MESSAGE = f"bar_notes must map bar numbers (1 to {MAX_BAR}) to text"


def sidecar_path(score_path: Path) -> Path:
    return score_path.with_name(score_path.name + SIDECAR_SUFFIX)


def empty_doc() -> dict:
    return {"version": NOTES_VERSION, "piece_note": "", "hard_bars": [], "bar_notes": {}, "updated_at": None}


def _text(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def validate(obj) -> dict:
    if not isinstance(obj, dict):
        raise ValueError("notes must be a JSON object")
    piece_note = obj.get("piece_note")
    if piece_note is None:
        piece_note = ""
    if not isinstance(piece_note, str):
        raise ValueError("piece_note must be text")
    piece_note = _text(piece_note)
    if len(piece_note) > PIECE_NOTE_MAX:
        raise ValueError(f"the piece note is longer than {PIECE_NOTE_MAX} characters")
    bars = obj.get("hard_bars")
    if bars is None:
        bars = []
    if not isinstance(bars, list):
        raise ValueError(_BARS_MESSAGE)
    for n in bars:
        if not (isinstance(n, int) and not isinstance(n, bool) and 1 <= n <= MAX_BAR):
            raise ValueError(_BARS_MESSAGE)
    notes = obj.get("bar_notes")
    if notes is None:
        notes = {}
    if not isinstance(notes, dict):
        raise ValueError(_NOTES_MESSAGE)
    bar_notes = {}
    for key, value in notes.items():
        if not (isinstance(key, str) and _BAR_KEY.fullmatch(key)) or not isinstance(value, str):
            raise ValueError(_NOTES_MESSAGE)
        value = _text(value)
        if not value:
            continue
        if len(value) > BAR_NOTE_MAX:
            raise ValueError(f"the note on bar {key} is longer than {BAR_NOTE_MAX} characters")
        bar_notes[key] = value
    return {
        "piece_note": piece_note,
        "hard_bars": sorted(set(bars)),
        "bar_notes": dict(sorted(bar_notes.items(), key=lambda item: int(item[0]))),
    }


def is_empty(doc: dict) -> bool:
    return not doc["piece_note"] and not doc["hard_bars"] and not doc["bar_notes"]


def hard_ranges(bars) -> list[list[int]]:
    ranges = []
    for n in sorted(set(bars)):
        if ranges and n == ranges[-1][1] + 1:
            ranges[-1][1] = n
        else:
            ranges.append([n, n])
    return ranges


def read_notes(score_path: Path) -> dict:
    path = sidecar_path(score_path)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return empty_doc()
    obj = json.loads(text)
    if not isinstance(obj, dict) or obj.get("version") != NOTES_VERSION:
        raise ValueError("unsupported notes file")
    validated = validate(obj)
    updated_at = obj.get("updated_at")
    return {"version": NOTES_VERSION, **validated, "updated_at": updated_at if isinstance(updated_at, str) else None}


def write_notes(score_path: Path, payload, now=None) -> dict:
    doc = validate(payload)
    with _LOCK:
        if is_empty(doc):
            remove_sidecar(score_path)
            return empty_doc()
        stamp = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        stored = {"version": NOTES_VERSION, **doc, "updated_at": stamp}
        text = json.dumps(stored, ensure_ascii=False, indent=2) + "\n"
        target = sidecar_path(score_path)
        tmp = target.with_name(target.name + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        for attempt in range(5):
            try:
                os.replace(tmp, target)
                break
            except PermissionError:
                if attempt == 4:
                    try:
                        tmp.unlink(missing_ok=True)
                    except OSError:
                        pass
                    raise
                time.sleep(0.05)
        return stored


def remove_sidecar(score_path: Path) -> None:
    try:
        sidecar_path(score_path).unlink(missing_ok=True)
    except OSError:
        pass


def evidence_block(scores_dir) -> dict:
    folder = Path(scores_dir)
    if not (folder / "library.sqlite").exists():
        return {}
    from .index import Library

    files_dir = (folder / "files").resolve()
    with Library(folder) as lib:
        rows = lib.search(None, downloaded=True, include_conflicts=True, limit=None)
    out = {}
    for row in sorted(rows, key=lambda r: r["id"]):
        if not row["file_path"]:
            continue
        full = (folder / row["file_path"]).resolve()
        if not full.is_relative_to(files_dir) or not sidecar_path(full).is_file():
            continue
        try:
            doc = read_notes(full)
        except (OSError, ValueError):
            continue
        if is_empty(doc):
            continue
        out[row["id"]] = {
            "title": row["title"],
            "piece_note": doc["piece_note"],
            "hard_bars": doc["hard_bars"],
            "hard_ranges": hard_ranges(doc["hard_bars"]),
            "bar_notes": doc["bar_notes"],
            "updated_at": doc["updated_at"],
        }
    return out


def handle_get(score_path) -> tuple[int, dict]:
    if score_path is None:
        return 404, {"error": "score file not found"}
    try:
        return 200, read_notes(score_path)
    except (OSError, ValueError) as e:
        return 500, {"error": f"could not read the notes: {e}"}


def handle_post(score_path, body: bytes, content_type, now=None) -> tuple[int, dict]:
    if score_path is None:
        return 404, {"error": "score file not found"}
    if (content_type or "").split(";")[0].strip().lower() != "application/json":
        return 415, {"error": "send the notes as application/json"}
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return 400, {"error": "notes are not valid JSON"}
    try:
        stored = write_notes(score_path, payload, now)
    except ValueError as e:
        return 400, {"error": str(e)}
    except OSError as e:
        return 500, {"error": f"could not save the notes: {e}"}
    return 200, stored
