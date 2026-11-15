import copy
import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from mid_fixtures import engine_like, notes_to_events, write

from rusty_piano_coach import attempts, practice_log
from rusty_piano_coach.cli import main

UTC = timezone.utc


def write_session(folder: Path, name: str, first_ms: float, last_ms: float) -> Path:
    return write(folder / name, engine_like(notes_to_events([(60, first_ms, last_ms, 80)])))


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


@pytest.fixture
def folders(tmp_path):
    sessions_dir = tmp_path / "sessions"
    attempts_dir = tmp_path / "attempts"
    sessions_dir.mkdir()
    write_session(sessions_dir, "session-20261103-200000.mid", 1000, 601000)
    write_session(sessions_dir, "session-20261104-200000.mid", 0, 300000)
    attempts.save_attempt(
        attempts_dir,
        make_attempt(
            "2026-11-04T20:01:00Z",
            120000,
            ended="2026-11-04T20:03:00Z",
            counts={"correctNotes": 4, "missedNotes": 1, "wrongNotes": 0},
        ),
    )
    attempts.save_attempt(
        attempts_dir,
        make_attempt(
            "2026-11-05T09:00:00Z",
            180000,
            counts={"correctNotes": 9, "missedNotes": 1, "wrongNotes": 0},
        ),
    )
    return sessions_dir, attempts_dir


def test_days_streak_and_pieces(folders):
    sessions_dir, attempts_dir = folders
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 5), tz=UTC)
    assert log["days"] == [
        {"date": "2026-11-05", "minutes": 3.0, "sessions": 0, "attempts": 1},
        {"date": "2026-11-04", "minutes": 5.0, "sessions": 1, "attempts": 1},
        {"date": "2026-11-03", "minutes": 10.0, "sessions": 1, "attempts": 0},
    ]
    assert log["streak"] == {"current": 3, "longest": 3}
    assert log["total_minutes"] == 18.0
    assert log["window_minutes"] == 18.0
    assert log["inputs"]["sessions"] == 2
    assert log["inputs"]["attempts"] == 2
    piece = log["pieces"][0]
    assert piece["score_id"] == "local:aaa"
    assert piece["title"] == "Piece A"
    assert piece["attempts"] == 2
    assert piece["minutes"] == 5.0
    assert piece["first"] == "2026-11-04"
    assert piece["last"] == "2026-11-05"
    assert piece["best_accuracy"] == 0.9


def test_streak_continues_yesterday_forgives_one_miss_and_breaks_after(folders):
    sessions_dir, attempts_dir = folders
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 6), tz=UTC)
    assert log["streak"]["current"] == 3
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 7), tz=UTC)
    assert log["streak"]["current"] == 3
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 8), tz=UTC)
    assert log["streak"] == {"current": 0, "longest": 3}


def _days(*ns):
    return {date(2026, 11, n) for n in ns}


@pytest.mark.parametrize(
    "days,today,current,longest",
    [
        ((1, 2, 4, 5), 5, 4, 4),
        ((1, 2, 5), 5, 1, 2),
        ((1, 3, 5), 5, 2, 2),
        ((*range(1, 4), *range(5, 11), 12, 13), 13, 11, 11),
        ((*range(1, 4), *range(5, 10), 11, 12), 12, 7, 8),
        ((1, 2), 4, 2, 2),
        ((1, 2), 5, 0, 2),
        ((1, 3), 4, 2, 2),
        ((1, 3), 5, 1, 2),
    ],
)
def test_streak_grace_rule(days, today, current, longest):
    assert practice_log._streaks(_days(*days), date(2026, 11, today)) == {
        "current": current,
        "longest": longest,
    }


def test_old_isolated_session_does_not_change_longest(folders):
    sessions_dir, attempts_dir = folders
    write_session(sessions_dir, "session-20261030-200000.mid", 0, 60000)
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 5), tz=UTC)
    assert log["streak"]["longest"] == 3


def test_interval_is_split_at_local_midnight(tmp_path):
    attempts_dir = tmp_path / "attempts"
    attempts.save_attempt(attempts_dir, make_attempt("2026-11-01T23:50:00Z", 1200000))
    log = practice_log.build_log(tmp_path / "none", attempts_dir, today=date(2026, 11, 2), tz=UTC)
    assert log["days"] == [
        {"date": "2026-11-02", "minutes": 10.0, "sessions": 0, "attempts": 0},
        {"date": "2026-11-01", "minutes": 10.0, "sessions": 0, "attempts": 1},
    ]


def test_unreadable_session_is_listed_as_skipped(tmp_path):
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    write(sessions_dir / "session-20261102-100000.mid", b"nope")
    log = practice_log.build_log(sessions_dir, tmp_path / "attempts", today=date(2026, 11, 5), tz=UTC)
    assert any(s.startswith("session-20261102-100000.mid: ") for s in log["inputs"]["skipped"])


def test_missing_folders_give_empty_log(tmp_path):
    sessions_dir = tmp_path / "no_sessions"
    attempts_dir = tmp_path / "no_attempts"
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 5), tz=UTC)
    assert log["days"] == []
    assert log["streak"] == {"current": 0, "longest": 0}
    assert log["pieces"] == []
    assert not sessions_dir.exists()
    assert not attempts_dir.exists()


def test_format_log_text(folders):
    sessions_dir, attempts_dir = folders
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 5), tz=UTC)
    text = practice_log.format_log(log)
    assert "Streak: 3 days (longest 3)" in text
    assert "Piece A" in text
    assert "2026-11-05  Thu  3 min  (0 sessions, 1 attempt)" in text


def test_cli_json(folders, capsys):
    sessions_dir, attempts_dir = folders
    code = main([
        "log",
        "--sessions-dir", str(sessions_dir),
        "--attempts-dir", str(attempts_dir),
        "--today", "2026-11-05",
        "--utc",
        "--json",
    ])
    assert code == 0
    out = json.loads(capsys.readouterr().out)
    assert out["version"] == 1
    assert out["streak"]["current"] == 3
    assert "runs" in out["pieces"][0]
    assert "last_accuracy" in out["pieces"][0]


def test_pieces_have_runs_and_last_accuracy(folders):
    sessions_dir, attempts_dir = folders
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 5), tz=UTC)
    piece = log["pieces"][0]
    assert piece["last_accuracy"] == 0.9
    assert len(piece["runs"]) == 2
    first, second = piece["runs"]
    assert first["date"] == "2026-11-05"
    assert first["time"] == "09:00"
    assert first["started_at"] == "2026-11-05T09:00:00Z"
    assert first["minutes"] == 3.0
    assert first["accuracy"] == 0.9
    assert first["mode"] == "live"
    assert first["end"] == "done"
    assert second["date"] == "2026-11-04"
    assert second["time"] == "20:01"
    assert second["minutes"] == 2.0
    assert second["accuracy"] == 0.8
    assert re.fullmatch(attempts.ID_RE, first["id"])


def test_runs_are_capped_newest_first(tmp_path):
    attempts_dir = tmp_path / "attempts"
    start = datetime(2026, 11, 1, 10, 0, tzinfo=UTC)
    for i in range(12):
        attempts.save_attempt(attempts_dir, make_attempt((start + timedelta(hours=i)).isoformat(), 60000))
    log = practice_log.build_log(tmp_path / "none", attempts_dir, today=date(2026, 11, 2), tz=UTC)
    runs = log["pieces"][0]["runs"]
    assert len(runs) == 10
    assert runs[0]["time"] == "21:00"


def test_last_accuracy_skips_runs_without_notes(tmp_path):
    attempts_dir = tmp_path / "attempts"
    attempts.save_attempt(
        attempts_dir,
        make_attempt("2026-11-04T10:00:00Z", 60000, counts={"correctNotes": 3, "missedNotes": 1, "wrongNotes": 0}),
    )
    attempts.save_attempt(attempts_dir, make_attempt("2026-11-04T11:00:00Z", 60000))
    log = practice_log.build_log(tmp_path / "none", attempts_dir, today=date(2026, 11, 4), tz=UTC)
    piece = log["pieces"][0]
    assert piece["last_accuracy"] == 0.75
    assert piece["runs"][0]["accuracy"] is None


def test_text_output_ignores_runs(folders):
    sessions_dir, attempts_dir = folders
    log = practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 5), tz=UTC)
    text = practice_log.format_log(log)
    stripped = copy.deepcopy(log)
    for piece in stripped["pieces"]:
        del piece["runs"]
        del piece["last_accuracy"]
    assert practice_log.format_log(stripped) == text


def _bad_attempts():
    a = make_attempt("2026-11-04T10:00:00Z", 60000, ended="2026-11-04T10:01:00Z")
    a["duration_ms"] = "x"
    b = make_attempt("2026-11-04T11:00:00Z", 60000)
    b["score"]["id"] = ["x"]
    c = make_attempt("2026-11-04T12:00:00Z", 60000)
    c["score"]["title"] = 5
    d = make_attempt("2026-11-04T13:00:00Z", 60000)
    d["score"]["id"] = 7
    return {"bad-duration": a, "bad-id-list": b, "bad-title": c, "bad-id-int": d}


@pytest.mark.parametrize("name", ["bad-duration", "bad-id-list", "bad-title", "bad-id-int"])
def test_malformed_attempt_is_skipped_not_fatal(tmp_path, name):
    attempts_dir = tmp_path / "attempts"
    attempts.save_attempt(attempts_dir, make_attempt("2026-11-04T20:00:00Z", 120000))
    bad = _bad_attempts()[name]
    attempts_dir.mkdir(exist_ok=True)
    (attempts_dir / f"{name}.json").write_text(json.dumps({**bad, "id": name}), encoding="utf-8")
    log = practice_log.build_log(tmp_path / "none", attempts_dir, today=date(2026, 11, 4), tz=UTC)
    practice_log.format_log(log)
    assert log["inputs"]["attempts"] == 1
    assert any(name in s for s in log["inputs"]["skipped"])


def test_cli_rejects_bad_today():
    with pytest.raises(SystemExit) as exc:
        main(["log", "--today", "bad"])
    assert exc.value.code == 2


def _log_for(tmp_path, notes, attempt=None):
    sessions_dir = tmp_path / "sessions"
    attempts_dir = tmp_path / "attempts"
    sessions_dir.mkdir()
    write(sessions_dir / "session-20261103-200000.mid", engine_like(notes_to_events(notes)))
    if attempt is not None:
        attempts.save_attempt(attempts_dir, attempt)
    return practice_log.build_log(sessions_dir, attempts_dir, today=date(2026, 11, 3), tz=UTC)


def test_long_silence_is_not_counted(tmp_path):
    log = _log_for(tmp_path, [(60, 0, 1000, 80), (62, 600000, 601000, 80)])
    assert log["total_minutes"] < 0.1


def test_gap_of_exactly_two_minutes_counts(tmp_path):
    log = _log_for(tmp_path, [(60, 0, 60000, 80), (62, 180000, 240000, 80)])
    assert log["total_minutes"] == 4.0


def test_two_stretches_with_three_minute_gap(tmp_path):
    log = _log_for(tmp_path, [(60, 0, 60000, 80), (62, 240000, 300000, 80)])
    assert log["total_minutes"] == 2.0


def test_attempt_covering_silence_counts_its_time(tmp_path):
    attempt = make_attempt("2026-11-03T20:01:00Z", 180000, ended="2026-11-03T20:04:00Z")
    log = _log_for(tmp_path, [(60, 0, 60000, 80), (62, 300000, 360000, 80)], attempt)
    assert log["total_minutes"] == 5.0
