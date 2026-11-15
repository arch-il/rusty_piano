import json
from datetime import datetime, timedelta, timezone

import pytest

from rusty_piano_coach import attempts, data_paths, practice_log
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.server import handle_request, make_server


def get(tmp_path, path="/api/log", host="127.0.0.1:8765"):
    return handle_request(
        tmp_path / "lib",
        path,
        "GET",
        {"Host": host},
        Jobs(),
        attempts_dir=tmp_path / "attempts",
        sessions_dir=tmp_path / "sessions",
    )


def test_empty_folders_give_empty_log(tmp_path):
    r = get(tmp_path)
    assert r.status == 200
    body = json.loads(r.body)
    assert body["kind"] == "rusty_piano.practice_log"
    assert body["window_days"] == 30
    assert body["days"] == []
    assert body["pieces"] == []
    assert body["streak"] == {"current": 0, "longest": 0}
    assert not (tmp_path / "attempts").exists()
    assert not (tmp_path / "sessions").exists()


def test_saved_attempt_shows_up(tmp_path):
    started = (datetime.now(timezone.utc) - timedelta(minutes=2)).replace(microsecond=0)
    obj = {
        "version": 1,
        "kind": "rusty_piano.attempt",
        "score": {"id": "local:aaa", "title": "Piece A"},
        "mode": "live",
        "end": "done",
        "started_at": started.isoformat(),
        "duration_ms": 60000,
        "steps": [],
        "events": [],
        "summary": {"counts": {"correctNotes": 9, "missedNotes": 1, "wrongNotes": 0}},
    }
    stored = attempts.save_attempt(tmp_path / "attempts", obj)
    body = json.loads(get(tmp_path).body)
    piece = body["pieces"][0]
    assert piece["score_id"] == "local:aaa"
    assert piece["runs"][0]["id"] == stored["id"]
    assert piece["last_accuracy"] == 0.9
    assert body["days"][0]["attempts"] == 1


def test_days_param(tmp_path):
    r = get(tmp_path, "/api/log?days=7")
    assert r.status == 200
    assert json.loads(r.body)["window_days"] == 7


@pytest.mark.parametrize("days", ["0", "abc", "367", "-3", "²"])
def test_bad_days_is_400(tmp_path, days):
    r = get(tmp_path, f"/api/log?days={days}")
    assert r.status == 400
    assert json.loads(r.body)["error"] == "days must be a number from 1 to 366"


def test_evil_host_is_403(tmp_path):
    assert get(tmp_path, host="evil.example").status == 403


def test_post_is_404(tmp_path):
    r = handle_request(tmp_path / "lib", "/api/log", "POST", {"Host": "127.0.0.1:8765"}, Jobs())
    assert r.status == 404


def test_read_error_is_500(tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise OSError("disk gone")

    monkeypatch.setattr(practice_log, "build_log", boom)
    r = get(tmp_path)
    assert r.status == 500
    assert "could not read the practice log" in json.loads(r.body)["error"]


def test_make_server_takes_sessions_dir(tmp_path):
    server = make_server(tmp_path / "lib", 0, sessions_dir=tmp_path / "s")
    try:
        assert server.sessions_dir == tmp_path / "s"
    finally:
        server.server_close()
    server = make_server(tmp_path / "lib", 0)
    try:
        assert server.sessions_dir == data_paths.sessions_dir()
    finally:
        server.server_close()
