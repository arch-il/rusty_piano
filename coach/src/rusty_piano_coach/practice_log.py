"""Practice log: minutes per day (session and attempt spans, split at local midnight), the practice streak and the pieces worked on, from recorded session .mid files and saved attempts. Silences longer than 2 minutes inside a session are not counted. Pieces carry their last accuracy and newest runs (JSON only)."""

import json
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from pathlib import Path

from . import attempts, data_paths, sessions
from .localzone import LOCAL

LOG_VERSION = 1
LOG_KIND = "rusty_piano.practice_log"
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
TITLE_LIMIT = 40
RUNS_PER_PIECE = 10
ONE_DAY = timedelta(days=1)
GAP_MS = 120_000  # silences longer than 2 minutes inside a session are not practice time


def _active_spans(notes, gap_ms: float) -> list[tuple[float, float]]:
    spans: list[list[float]] = []
    for note in sorted(notes, key=lambda n: n.start_ms):
        if spans and note.start_ms <= spans[-1][1] + gap_ms:
            spans[-1][1] = max(spans[-1][1], note.end_ms)
        else:
            spans.append([note.start_ms, note.end_ms])
    return [(a, b) for a, b in spans]


def _aware(text: str) -> datetime:
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        raise ValueError(f"{text} has no time zone")
    return parsed


def _accuracy(counts: dict) -> float | None:
    correct = counts.get("correctNotes", 0)
    total = correct + counts.get("missedNotes", 0) + counts.get("wrongNotes", 0)
    return round(correct / total, 3) if total else None


def _split_minutes(start: datetime, end: datetime, tz: tzinfo) -> list[tuple[date, float]]:
    parts = []
    cur = start
    while cur < end:
        day = cur.astimezone(tz).date()
        midnight = datetime.combine(day + ONE_DAY, time(0), tzinfo=tz).astimezone(timezone.utc)
        stop = min(end, midnight)
        parts.append((day, (stop - cur).total_seconds() / 60))
        cur = stop
    return parts


def _run_back(practised: set[date], end: date, misses: list[date]) -> int:
    count = 0
    day = end
    while True:
        if day in practised:
            count += 1
        elif day - ONE_DAY in practised and all(m - day >= timedelta(days=7) for m in misses):
            misses.append(day)
        else:
            return count
        day -= ONE_DAY


def _streaks(practised: set[date], today: date) -> dict:
    # One missed day per rolling 7 days does not break a streak: a miss is forgiven when the days
    # before and after it are practised and no other forgiven miss is within 6 days. Forgiven days
    # are not counted. Today is never a miss (it is still pending).
    if today in practised:
        current = _run_back(practised, today, [])
    elif today - ONE_DAY in practised:
        current = _run_back(practised, today - ONE_DAY, [])
    elif today - 2 * ONE_DAY in practised:
        current = _run_back(practised, today - 2 * ONE_DAY, [today - ONE_DAY])
    else:
        current = 0
    longest = max([current] + [_run_back(practised, d, []) for d in practised])
    return {"current": current, "longest": longest}


def build_log(
    sessions_dir: Path,
    attempts_dir: Path,
    *,
    today: date | None = None,
    days: int = 14,
    tz: tzinfo | None = None,
) -> dict:
    if tz is None:
        tz = LOCAL
    if today is None:
        today = datetime.now(tz).date()
    skipped: list[str] = []
    intervals: list[tuple[datetime, datetime]] = []
    minutes: dict[date, float] = defaultdict(float)
    session_counts: dict[date, int] = defaultdict(int)
    attempt_counts: dict[date, int] = defaultdict(int)

    sessions_read = 0
    for path in sessions.sessions_in(Path(sessions_dir)):
        try:
            session = sessions.read_midi(path)
        except (ValueError, OSError) as e:
            skipped.append(f"{path.name}: {e}")
            continue
        sessions_read += 1
        if not session.notes:
            continue
        for span_start, span_end in _active_spans(session.notes, GAP_MS):
            intervals.append((
                session.started_at + timedelta(milliseconds=span_start),
                session.started_at + timedelta(milliseconds=span_end),
            ))
        start = session.started_at + timedelta(milliseconds=session.first_ms)
        session_counts[start.astimezone(tz).date()] += 1

    found, problems = attempts.list_attempts(Path(attempts_dir))
    skipped += problems
    items = []
    for a in found:
        try:
            started = _aware(a["started_at"])
            if a.get("ended_at"):
                ended = _aware(a["ended_at"])
            else:
                ended = started + timedelta(milliseconds=a["duration_ms"])
            duration = a["duration_ms"]
            if isinstance(duration, bool) or not isinstance(duration, (int, float)):
                raise ValueError("duration_ms is not a number")
            if not isinstance(a["score"]["id"], str):
                raise ValueError("score id is not a string")
            if a["score"].get("title") is not None and not isinstance(a["score"]["title"], str):
                raise ValueError("score title is not a string")
            items.append({
                "start": started,
                "end": ended,
                "date": started.astimezone(tz).date(),
                "score_id": a["score"]["id"],
                "title": a["score"].get("title"),
                "duration_ms": a["duration_ms"],
                "accuracy": _accuracy(a["summary"].get("counts", {})),
                "id": a.get("id") if isinstance(a.get("id"), str) else None,
                "started_text": a["started_at"],
                "time": started.astimezone(tz).strftime("%H:%M"),
                "mode": a.get("mode") if isinstance(a.get("mode"), str) else None,
                "end_text": a.get("end") if isinstance(a.get("end"), str) else None,
            })
        except (KeyError, TypeError, ValueError, AttributeError) as e:
            skipped.append(f"{a.get('id', '?')}.json: not a complete attempt ({e})")
            continue
    for item in items:
        intervals.append((item["start"], item["end"]))
        attempt_counts[item["date"]] += 1

    intervals.sort()
    merged: list[list[datetime]] = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    for start, end in merged:
        for day, m in _split_minutes(start, end, tz):
            minutes[day] += m

    practised = set(session_counts) | set(attempt_counts) | set(minutes)
    day_rows = [
        {
            "date": day.isoformat(),
            "minutes": round(minutes.get(day, 0.0), 1),
            "sessions": session_counts.get(day, 0),
            "attempts": attempt_counts.get(day, 0),
        }
        for day in sorted(practised, reverse=True)
    ]

    window_start = today - timedelta(days=days - 1)
    window_total = sum(m for day, m in minutes.items() if window_start <= day <= today)

    pieces: dict[str, dict] = {}
    for item in sorted(items, key=lambda i: i["start"]):
        piece = pieces.setdefault(item["score_id"], {
            "score_id": item["score_id"],
            "title": None,
            "attempts": 0,
            "minutes": 0.0,
            "first": None,
            "last": None,
            "best_accuracy": None,
            "last_accuracy": None,
            "runs": [],
        })
        if item["accuracy"] is not None:
            piece["last_accuracy"] = item["accuracy"]
        piece["runs"].append({
            "id": item["id"],
            "started_at": item["started_text"],
            "date": item["date"].isoformat(),
            "time": item["time"],
            "minutes": round(item["duration_ms"] / 60000, 1),
            "accuracy": item["accuracy"],
            "mode": item["mode"],
            "end": item["end_text"],
        })
        if item["title"] is not None:
            piece["title"] = item["title"]
        piece["attempts"] += 1
        piece["minutes"] += item["duration_ms"] / 60000
        day = item["date"].isoformat()
        piece["first"] = piece["first"] or day
        piece["last"] = day
        if item["accuracy"] is not None and (piece["best_accuracy"] is None or item["accuracy"] > piece["best_accuracy"]):
            piece["best_accuracy"] = item["accuracy"]
    piece_rows = sorted(pieces.values(), key=lambda p: (p["last"], p["attempts"]), reverse=True)
    for piece in piece_rows:
        piece["minutes"] = round(piece["minutes"], 1)
        piece["runs"] = list(reversed(piece["runs"]))[:RUNS_PER_PIECE]

    return {
        "version": LOG_VERSION,
        "kind": LOG_KIND,
        "today": today.isoformat(),
        "window_days": days,
        "days": day_rows,
        "streak": _streaks(practised, today),
        "total_minutes": round(sum(minutes.values()), 1),
        "window_minutes": round(window_total, 1),
        "pieces": piece_rows,
        "inputs": {"sessions": sessions_read, "attempts": len(items), "skipped": skipped},
    }


def _cut(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 3] + "..."


def _minutes(m: float) -> str:
    if 0 < m < 0.5:
        return "<1 min"
    return f"{round(m)} min"


def _count(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def format_log(log: dict) -> str:
    window = log["window_days"]
    today = date.fromisoformat(log["today"])
    window_start = today - timedelta(days=window - 1)
    lines = [f"Practice log (last {window} days, today {log['today']})"]
    inside = [d for d in log["days"] if window_start <= date.fromisoformat(d["date"]) <= today]
    if not inside:
        lines.append(f"  no practice in the last {window} days")
    for d in inside:
        weekday = WEEKDAYS[date.fromisoformat(d["date"]).weekday()]
        lines.append(
            f"{d['date']}  {weekday}  {_minutes(d['minutes'])}"
            f"  ({_count(d['sessions'], 'session')}, {_count(d['attempts'], 'attempt')})"
        )
    streak = log["streak"]
    lines.append(f"Streak: {_count(streak['current'], 'day')} (longest {streak['longest']})")
    hours, mins = divmod(round(log["total_minutes"]), 60)
    span = f"{hours} h {mins} min" if hours else f"{mins} min"
    lines.append(f"Total: {span} over {_count(len(log['days']), 'day')}")
    lines.append("Pieces worked on:")
    if not log["pieces"]:
        lines.append("  none yet (pieces come from saved attempts)")
    for p in log["pieces"]:
        text = f"  {_cut(str(p['title'] or p['score_id']), TITLE_LIMIT)}  {_count(p['attempts'], 'attempt')}, last {p['last']}"
        if p["best_accuracy"] is not None:
            text += f", best {round(p['best_accuracy'] * 100)}%"
        lines.append(text)
    lines += [f"Skipped: {s}" for s in log["inputs"]["skipped"]]
    return "\n".join(lines)


def run_log(args) -> int:
    tz = timezone.utc if args.utc else None
    try:
        log = build_log(
            data_paths.sessions_dir(args.sessions_dir),
            data_paths.attempts_dir(args.attempts_dir),
            today=args.today,
            days=args.days,
            tz=tz,
        )
    except OSError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(log, ensure_ascii=False, indent=2))
    else:
        print(format_log(log))
    return 0
