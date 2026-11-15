"""Read-only replay data for the sheet music page (GET /api/replay/...): the recent attempts of a score and one saved attempt, session recordings, and a session .mid matched against a score with the same alignment as coach analyse."""

import json
import re
from datetime import timezone
from pathlib import Path

from . import attempt_cache, attempts, sessions
from .library.index import Library

ATTEMPT_LIST_LIMIT = 10
SESSION_LIST_LIMIT = 10
LEAD_MS = 500.0
TAIL_MS = 1500.0
HANDS = ("both", "right", "left")


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _score_file(data_dir: Path, score_id: str) -> Path | None:
    with Library(data_dir) as lib:
        row = lib.get(score_id)
    if row is None or not row["file_path"]:
        return None
    full = (Path(data_dir) / row["file_path"]).resolve()
    root = (Path(data_dir) / "files").resolve()
    return full if full.is_relative_to(root) and full.is_file() else None


def list_sessions(sessions_dir: Path) -> tuple[int, dict]:
    try:
        paths = list(reversed(sessions.sessions_in(Path(sessions_dir))))[:SESSION_LIST_LIMIT]
        items = [
            {
                "name": p.name,
                "started_at": _iso(sessions.session_start_from_name(p.name)),
                "size_bytes": p.stat().st_size,
            }
            for p in paths
        ]
    except OSError as e:
        return 500, {"error": f"could not read the recordings: {e}"}
    return 200, {"sessions": items}


def has_repeated_bar_numbers(written_bars) -> bool:
    numbers = [b[0] for b in written_bars]
    return len(numbers) != len(set(numbers))


def session_replay(data_dir: Path, sessions_dir: Path, query: dict) -> tuple[int, dict]:
    name = _arg(query, "name")
    score_id = _arg(query, "score")
    hands = _arg(query, "hands") or "both"
    if not sessions.NAME_RE.fullmatch(name):
        return 400, {"error": "name must be a session file name like session-20261106-090000.mid"}
    if not score_id:
        return 400, {"error": "score is required"}
    if hands not in HANDS:
        return 400, {"error": "hands must be both, right or left"}
    path = Path(sessions_dir) / name
    if not path.is_file():
        return 404, {"error": "no such session recording"}
    score_path = _score_file(data_dir, score_id)
    if score_path is None:
        return 404, {"error": "score file not found"}
    try:
        session = sessions.read_midi(path)
    except (OSError, ValueError) as e:
        return 400, {"error": f"could not read the recording: {e}"}
    if not session.notes:
        return 422, {"error": "this recording has no notes"}

    from . import compare

    try:
        loaded = compare.load_score(score_path)
    except Exception as e:
        return 500, {"error": f"could not read the score: {e}"}
    expected, _order, method = compare.expected_notes(loaded, hands=hands)
    if not expected:
        return 422, {"error": "this score has no notes for the chosen hands"}
    try:
        analysis = compare.analyse(expected, session.notes)
    except ValueError as e:
        return 400, {"error": f"this recording is too long to match with this score ({e})"}
    rows = analysis["notes"]
    if not any(r["kind"] == "match" for r in rows):
        return 422, {"error": "none of this score's notes were found in this recording"}

    timed = [r for r in rows if r["kind"] in ("match", "wrong") and r["start_ms"] is not None]
    w0 = max(0.0, min(r["start_ms"] for r in timed) - LEAD_MS)
    w1 = max(r["end_ms"] if r["end_ms"] is not None else r["start_ms"] for r in timed) + TAIL_MS

    bar_index: dict = {}
    for k, b in enumerate(loaded.written_bars):
        bar_index.setdefault(b[0], k)

    played = [
        {
            "note": n.pitch,
            "on_ms": round(n.start_ms - w0, 1),
            "off_ms": round(n.end_ms - w0, 1),
            "velocity": n.velocity,
        }
        for n in session.notes
        if w0 <= n.start_ms <= w1
    ]
    pedal = [{"at_ms": round(p.t_ms - w0, 1), "on": p.on} for p in session.pedal if w0 <= p.t_ms <= w1]
    before = [p for p in session.pedal if p.t_ms < w0]
    if before and before[-1].on:
        pedal.insert(0, {"at_ms": 0.0, "on": True})

    notes = []
    unplaced = 0
    for r in rows:
        if r["kind"] == "not_reached":
            continue
        if r["kind"] == "extra" and not (r["start_ms"] is not None and w0 <= r["start_ms"] <= w1):
            continue
        mi = bar_index.get(r["bar"]) if r["bar"] is not None else None
        if mi is None:
            unplaced += 1
            continue
        notes.append(
            {
                "kind": r["kind"],
                "measure_index": mi,
                "bar": r["bar"],
                "pass": r["pass"],
                "beat": r["beat"],
                "score_q": r["score_q"],
                "part": r["part"],
                "expected": r["expected"],
                "played": r["played"],
                "at_ms": round(r["start_ms"] - w0, 1) if r["start_ms"] is not None else None,
                "offset_ms": r["offset_ms"],
                "timing_score": r["timing_score"],
            }
        )
    warnings = (
        list(analysis["warnings"])
        + list(loaded.warnings)
        + (
            ["this score repeats bar numbers (alternate endings?); marks may be placed in the wrong bar"]
            if has_repeated_bar_numbers(loaded.written_bars)
            else []
        )
        + ([f"{unplaced} notes could not be placed on the score"] if unplaced else [])
    )
    return 200, {
        "version": 1,
        "kind": "rusty_piano.replay",
        "session": {"name": name, "started_at": _iso(session.started_at)},
        "score": {"id": score_id, "title": loaded.title},
        "hands": hands,
        "expansion": method,
        "window_ms": {"start": round(w0, 1), "end": round(w1, 1)},
        "duration_ms": round(w1 - w0, 1),
        "summary": {
            k: analysis["summary"][k]
            for k in ("matched", "wrong", "missed", "extra", "accuracy", "bpm", "timing_score")
        },
        "played": played,
        "pedal": pedal,
        "notes": notes,
        "warnings": warnings,
    }


def _arg(query: dict, name: str) -> str:
    values = query.get(name)
    return values[0].strip() if values else ""


def _accuracy(counts) -> float | None:
    if not isinstance(counts, dict):
        return None
    try:
        correct = counts.get("correctNotes", 0)
        total = correct + counts.get("missedNotes", 0) + counts.get("wrongNotes", 0)
        return round(correct / total, 3) if total else None
    except TypeError:
        return None


def _str_or_none(value):
    return value if isinstance(value, str) else None


def attempt_item(a: dict) -> dict | None:
    attempt_id = a.get("id")
    if not isinstance(attempt_id, str) or not re.fullmatch(attempts.ID_RE, attempt_id):
        return None
    practice = a.get("practice") if isinstance(a.get("practice"), dict) else {}
    summary = a.get("summary") if isinstance(a.get("summary"), dict) else {}
    duration = a.get("duration_ms")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        duration = None
    hands = practice.get("hands")
    r = practice.get("range")
    if isinstance(r, dict) and isinstance(r.get("from"), int) and isinstance(r.get("to"), int):
        range_ = {"from": r["from"], "to": r["to"]}
    else:
        range_ = None
    return {
        "id": attempt_id,
        "started_at": _str_or_none(a.get("started_at")),
        "mode": _str_or_none(a.get("mode")),
        "end": _str_or_none(a.get("end")),
        "duration_ms": duration,
        "hands": hands if hands in ("both", "right", "left") else "both",
        "range": range_,
        "loop": bool(practice.get("loop")),
        "accuracy": _accuracy(summary.get("counts")),
        "drill_id": _str_or_none(a.get("drill_id")),
    }


def list_for_score(attempts_dir: Path, score_id: str) -> tuple[int, dict]:
    if not score_id:
        return 400, {"error": "score is required"}
    folder = Path(attempts_dir)
    if not folder.is_dir():
        return 200, {"attempts": []}
    items = []
    for a in attempt_cache.read_attempts(folder)[0]:
        if a.get("kind") != attempts.ATTEMPT_KIND:
            continue
        score = a.get("score")
        if not isinstance(score, dict) or score.get("id") != score_id:
            continue
        item = attempt_item(a)
        if item is None:
            continue
        items.append(item)
    items.sort(key=attempts.started_key, reverse=True)
    return 200, {"attempts": items[:ATTEMPT_LIST_LIMIT]}


def attempt_by_id(attempts_dir: Path, text: str) -> tuple[int, dict]:
    if not re.fullmatch(attempts.ID_RE, text):
        return 400, {"error": "not an attempt id"}
    path = Path(attempts_dir) / f"{text}.json"
    if not path.is_file():
        return 404, {"error": "no such attempt"}
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return 500, {"error": f"could not read the attempt: {e}"}
    if not isinstance(obj, dict) or obj.get("version") not in attempts.READ_VERSIONS:
        return 500, {"error": "this file is not a version 1 or 2 attempt"}
    return 200, obj


def handle(
    rest: list[str], query: dict, *, data_dir: Path, attempts_dir: Path, sessions_dir: Path
) -> tuple[int, dict]:
    if rest == ["attempts"]:
        return list_for_score(attempts_dir, _arg(query, "score"))
    if len(rest) == 2 and rest[0] == "attempts":
        return attempt_by_id(attempts_dir, rest[1])
    if rest == ["sessions"]:
        return list_sessions(sessions_dir)
    if rest == ["session"]:
        return session_replay(data_dir, sessions_dir, query)
    return 404, {"error": "not found"}
