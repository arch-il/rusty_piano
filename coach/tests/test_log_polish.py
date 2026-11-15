from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest

from rusty_piano_coach import attempts, practice_log
from rusty_piano_coach.localzone import LOCAL

UTC = timezone.utc


def make_attempt(started: str, duration_ms: int, *, ended: str | None = None, counts=None, title="Piece A", score_id="local:aaa"):
    obj = {
        "version": 1,
        "kind": "rusty_piano.attempt",
        "score": {"id": score_id, "title": title},
        "mode": "live",
        "end": "done",
        "started_at": started,
        "duration_ms": duration_ms,
        "steps": [],
        "events": [],
        "summary": {"counts": counts or {"correctNotes": 0, "missedNotes": 0, "wrongNotes": 0}},
    }
    if ended is not None:
        obj["ended_at"] = ended
    return obj


def berlin():
    try:
        return ZoneInfo("Europe/Berlin")
    except ZoneInfoNotFoundError:
        pytest.skip("Europe/Berlin is not available")


def test_local_zone_matches_the_os():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    for step in range(0, 365 * 8):
        ts = (start + timedelta(hours=3 * step)).timestamp()
        converted = datetime.fromtimestamp(ts, UTC).astimezone(LOCAL).replace(tzinfo=None)
        assert converted == datetime.fromtimestamp(ts)


def test_local_midnight_matches_the_os():
    day = date(2026, 1, 1)
    while day.year == 2026:
        assert datetime.combine(day, time(0), tzinfo=LOCAL).timestamp() == datetime.combine(day, time(0)).timestamp()
        day += timedelta(days=1)


def test_default_tz_follows_the_zone_rules(monkeypatch, tmp_path):
    monkeypatch.setattr(practice_log, "LOCAL", berlin())
    attempts_dir = tmp_path / "attempts"
    attempts.save_attempt(
        attempts_dir,
        make_attempt("2026-07-01T21:30:00Z", 3600000, ended="2026-07-01T22:30:00Z"),
    )
    log = practice_log.build_log(tmp_path / "sessions", attempts_dir, today=date(2026, 7, 2))
    assert log["days"] == [
        {"date": "2026-07-02", "minutes": 30.0, "sessions": 0, "attempts": 0},
        {"date": "2026-07-01", "minutes": 30.0, "sessions": 0, "attempts": 1},
    ]


def test_singular_words(tmp_path):
    attempts_dir = tmp_path / "attempts"
    attempts.save_attempt(attempts_dir, make_attempt("2026-11-05T09:00:00Z", 180000))
    log = practice_log.build_log(tmp_path / "sessions", attempts_dir, today=date(2026, 11, 5), tz=UTC)
    text = practice_log.format_log(log)
    assert "Streak: 1 day (longest 1)" in text
    assert "over 1 day" in text
    assert "1 attempt, last 2026-11-05" in text
    assert "1 days" not in text
    assert "1 attempts" not in text
