import json
from datetime import datetime, timezone

from rusty_piano_coach import attempts
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.server import handle_request

from test_server_replay import make_attempt


def get(tmp_path, path, host="127.0.0.1:8765"):
    return handle_request(
        tmp_path / "lib",
        path,
        "GET",
        {"Host": host},
        Jobs(),
        attempts_dir=tmp_path / "attempts",
        sessions_dir=tmp_path / "sessions",
    )


def save(tmp_path, started_at, second):
    obj = make_attempt("local:aaa")
    obj["started_at"] = started_at
    return attempts.save_attempt(
        tmp_path / "attempts",
        obj,
        now=datetime(2026, 11, 6, 9, 0, second, tzinfo=timezone.utc),
    )


def test_runs_are_ordered_by_start_time_newest_first(tmp_path):
    late_saved_early_start = save(tmp_path, "2026-11-06T08:00:00Z", 5)
    early_saved_late_start = save(tmp_path, "2026-11-06T10:00:00Z", 1)
    r = get(tmp_path, "/api/replay/attempts?score=local%3Aaaa")
    assert r.status == 200
    ids = [i["id"] for i in json.loads(r.body)["attempts"]]
    assert ids == [early_saved_late_start["id"], late_saved_early_start["id"]]


def test_second_call_does_not_reparse_and_new_attempt_appears(tmp_path, monkeypatch):
    from rusty_piano_coach import attempt_cache

    save(tmp_path, "2026-11-06T08:00:00Z", 5)
    calls = []
    real = attempt_cache._read_json
    monkeypatch.setattr(attempt_cache, "_read_json", lambda p: calls.append(p) or real(p))
    url = "/api/replay/attempts?score=local%3Aaaa"
    first = json.loads(get(tmp_path, url).body)["attempts"]
    assert len(calls) == 1
    again = json.loads(get(tmp_path, url).body)["attempts"]
    assert len(calls) == 1
    assert again == first
    newer = save(tmp_path, "2026-11-06T10:00:00Z", 1)
    ids = [i["id"] for i in json.loads(get(tmp_path, url).body)["attempts"]]
    assert ids[0] == newer["id"] and len(ids) == 2
    assert len(calls) == 2
