from datetime import datetime, timezone

from test_sight import sight_attempt

from rusty_piano_coach import attempt_cache, attempts, sight

UTC = timezone.utc


def _save(folder, minute, **over):
    attempts.save_attempt(folder, sight_attempt(**over), now=datetime(2026, 11, 6, 20, minute, tzinfo=UTC))


def _fill(folder):
    _save(folder, 0, started_at="2026-11-06T20:00:00Z")
    _save(folder, 1, started_at="2026-11-06T20:01:00Z")
    _save(folder, 2, started_at="2026-11-06T20:02:00Z")
    _save(folder, 3, score={"id": "piece:bach", "title": "Bach", "composer": None})


def test_history_matches_uncached_listing(tmp_path):
    _fill(tmp_path)
    found, _ = attempts.list_attempts(tmp_path)
    rows = sorted(
        (a for a in found if sight.is_sight(a["score"]["id"])),
        key=lambda a: (sight._parse_started(a["started_at"]), a["id"]),
    )
    assert sight.history(tmp_path) == {"rounds": [sight._round(a) for a in rows]}
    assert len(rows) == 3


def test_second_call_does_not_reparse(tmp_path, monkeypatch):
    _fill(tmp_path)
    first = sight.history(tmp_path)
    calls = []
    real = attempt_cache._read_json
    monkeypatch.setattr(attempt_cache, "_read_json", lambda p: calls.append(p) or real(p))
    assert sight.history(tmp_path) == first
    assert calls == []


def test_new_attempt_shows_up(tmp_path):
    _fill(tmp_path)
    assert len(sight.history(tmp_path)["rounds"]) == 3
    _save(tmp_path, 4, started_at="2026-11-06T20:04:00Z")
    rounds = sight.history(tmp_path)["rounds"]
    assert len(rounds) == 4
    assert rounds[-1]["started_at"] == "2026-11-06T20:04:00Z"
