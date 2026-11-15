"""Follower attempts saved by the sheet music page (one JSON file per run): validate, save, list and load them.

Versions 1 and 2 are read; the page writes 2 (version 2 adds drill_id, plan_id and tags).
"""

import json
import os
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

ATTEMPT_VERSION = 2
READ_VERSIONS = (1, 2)
ATTEMPT_KIND = "rusty_piano.attempt"
MODES = ("wait", "live")
ENDS = ("done", "stop", "interrupted")
EVENT_TYPES = ("note_on", "note_off", "sustain")
SOURCES = ("engine", "keyboard", "autoplay")
MAX_EVENTS = 500_000
ID_RE = r"^attempt-\d{8}-\d{6}-[0-9a-f]{6}(-\d+)?$"


def _is_text(value, limit: int) -> bool:
    return isinstance(value, str) and 0 < len(value) <= limit


def _is_iso(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def validate_attempt(obj) -> None:
    if not isinstance(obj, dict):
        raise ValueError("attempt must be a JSON object")
    if obj.get("version") not in READ_VERSIONS:
        raise ValueError("unsupported attempt version (expected 1 or 2)")
    if obj.get("kind") != ATTEMPT_KIND:
        raise ValueError("attempt kind must be rusty_piano.attempt")
    score = obj.get("score")
    if not isinstance(score, dict) or not _is_text(score.get("id"), 500):
        raise ValueError("score.id must be a non-empty string")
    if obj.get("mode") not in MODES:
        raise ValueError("mode must be wait or live")
    if obj.get("end") not in ENDS:
        raise ValueError("end must be done, stop or interrupted")
    if not _is_iso(obj.get("started_at")):
        raise ValueError("started_at must be an ISO date-time")
    if not isinstance(obj.get("steps"), list):
        raise ValueError("steps must be a list")
    events = obj.get("events")
    if not isinstance(events, list):
        raise ValueError("events must be a list")
    if len(events) > MAX_EVENTS:
        raise ValueError("too many events (limit 500000)")
    for i, ev in enumerate(events):
        if not isinstance(ev, dict) or ev.get("type") not in EVENT_TYPES:
            raise ValueError(f"event {i}: unknown type")
        if ev.get("source") not in SOURCES:
            raise ValueError(f"event {i}: unknown source")
    if not isinstance(obj.get("summary"), dict):
        raise ValueError("summary must be an object")
    if obj["version"] == 2:
        if "drill_id" not in obj or not (obj["drill_id"] is None or _is_text(obj["drill_id"], 100)):
            raise ValueError("drill_id must be null or a short string")
        if "plan_id" not in obj or not (obj["plan_id"] is None or _is_text(obj["plan_id"], 40)):
            raise ValueError("plan_id must be null or a short string")
        tags = obj.get("tags")
        if "tags" not in obj or not isinstance(tags, list) or len(tags) > 10:
            raise ValueError("tags must be a list of short lowercase words")
        if not all(isinstance(t, str) and re.fullmatch(r"[a-z0-9-]{1,20}", t) for t in tags):
            raise ValueError("tags must be a list of short lowercase words")


def new_attempt_id(now: datetime | None = None) -> str:
    if now is None:
        now = datetime.now(timezone.utc)
    return now.strftime("attempt-%Y%m%d-%H%M%S-") + secrets.token_hex(3)


def save_attempt(attempts_dir: Path, obj: dict, now: datetime | None = None) -> dict:
    validate_attempt(obj)
    if now is None:
        now = datetime.now(timezone.utc)
    folder = Path(attempts_dir)
    folder.mkdir(parents=True, exist_ok=True)
    attempt_id = new_attempt_id(now)
    base = attempt_id
    n = 2
    while (folder / f"{attempt_id}.json").exists():
        attempt_id = f"{base}-{n}"
        n += 1
    saved_at = now.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    stored = {"version": obj["version"], "id": attempt_id, "saved_at": saved_at}
    for key, value in obj.items():
        if key not in ("version", "id", "saved_at"):
            stored[key] = value
    target = folder / f"{attempt_id}.json"
    tmp = folder / f"{attempt_id}.json.tmp"
    tmp.write_text(json.dumps(stored, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, target)
    return stored


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def started_key(obj) -> tuple:
    """Sort key for newest-first: started_at as an aware time (naive counts as UTC; missing or bad sorts oldest), then the id."""
    value = obj.get("started_at") if isinstance(obj, dict) else None
    parsed = None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            parsed = None
    if parsed is None:
        parsed = datetime.min.replace(tzinfo=timezone.utc)
    elif parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    ident = obj.get("id") if isinstance(obj, dict) else None
    return (parsed, ident if isinstance(ident, str) else "")


def _entries(folder: Path) -> tuple[list[tuple[Path, dict]], list[str]]:
    if not folder.is_dir():
        return [], []
    kept = []
    problems = []
    for path in sorted(folder.glob("*.json"), key=lambda p: p.name):
        try:
            obj = _read(path)
        except (OSError, ValueError) as e:
            problems.append(f"{path.name}: unreadable ({e})")
            continue
        if isinstance(obj, dict) and obj.get("version") in READ_VERSIONS:
            kept.append((path, obj))
        else:
            problems.append(f"{path.name}: not a version 1 or 2 attempt")
    return kept, problems


def list_attempts(attempts_dir: Path) -> tuple[list[dict], list[str]]:
    entries, problems = _entries(Path(attempts_dir))
    return [obj for _, obj in entries], problems


def attempt_drill(obj: dict) -> tuple[str | None, str | None, tuple[str, ...]]:
    if obj.get("version") != 2:
        return None, None, ()
    drill_id = obj.get("drill_id")
    plan_id = obj.get("plan_id")
    tags = obj.get("tags")
    if not isinstance(drill_id, str) and drill_id is not None:
        drill_id = None
    if not isinstance(plan_id, str) and plan_id is not None:
        plan_id = None
    if not isinstance(tags, list):
        return drill_id, plan_id, ()
    return drill_id, plan_id, tuple(t for t in tags if isinstance(t, str))


def load_attempt_file(attempts_dir, text) -> tuple[dict, Path]:
    folder = Path(attempts_dir)
    if text == "latest":
        entries, _ = _entries(folder)
        if not entries:
            raise LookupError("no attempts saved yet")
        path, obj = max(entries, key=lambda e: (started_key(e[1])[0], e[0].name))
        return obj, path
    if text.endswith(".json") and Path(text).is_file():
        return _read(Path(text)), Path(text)
    if re.fullmatch(ID_RE, text) and (folder / f"{text}.json").is_file():
        path = folder / f"{text}.json"
        return _read(path), path
    if len(text) >= 4:
        entries, _ = _entries(folder)
        matches = [(p, a) for p, a in entries if str(a.get("id", "")).startswith(text)]
        if len(matches) == 1:
            return matches[0][1], matches[0][0]
        if len(matches) > 1:
            raise LookupError(f"'{text}' matches {len(matches)} attempts; give more characters")
    raise LookupError(f"no attempt matches '{text}'")


def load_attempt(attempts_dir: Path, text: str) -> dict:
    return load_attempt_file(attempts_dir, text)[0]
