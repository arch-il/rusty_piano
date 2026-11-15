import json
from datetime import datetime, timezone

from rusty_piano_coach import attempts
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.server import handle_request


def get(tmp_path, path, host="127.0.0.1:8765", method="GET", headers=None):
    return handle_request(
        tmp_path / "lib",
        path,
        method,
        headers or {"Host": host},
        Jobs(),
        attempts_dir=tmp_path / "attempts",
        sessions_dir=tmp_path / "sessions",
    )


def make_attempt(score_id):
    return {
        "version": 2,
        "kind": "rusty_piano.attempt",
        "score": {"id": score_id, "title": "Piece"},
        "mode": "live",
        "end": "done",
        "started_at": "2026-11-06T09:00:00Z",
        "duration_ms": 60000,
        "practice": {"hands": "right", "range": None, "loop": False},
        "plan": {"length_quarters": 8},
        "steps": [],
        "events": [],
        "summary": {"counts": {"correctNotes": 9, "missedNotes": 1, "wrongNotes": 0}},
        "drill_id": None,
        "plan_id": None,
        "tags": [],
    }


def save(tmp_path, score_id, second):
    return attempts.save_attempt(
        tmp_path / "attempts",
        make_attempt(score_id),
        now=datetime(2026, 11, 6, 9, 0, second, tzinfo=timezone.utc),
    )


def test_list_is_newest_first_and_only_this_score(tmp_path):
    a1 = save(tmp_path, "local:aaa", 1)
    save(tmp_path, "local:bbb", 2)
    a2 = save(tmp_path, "local:aaa", 3)
    r = get(tmp_path, "/api/replay/attempts?score=local%3Aaaa")
    status, body = r.status, r.body
    assert status == 200
    body = json.loads(body)
    assert [i["id"] for i in body["attempts"]] == [a2["id"], a1["id"]]
    first = body["attempts"][0]
    assert set(first) == {
        "id", "started_at", "mode", "end", "duration_ms", "hands", "range", "loop", "accuracy", "drill_id",
    }
    assert first["accuracy"] == 0.9
    assert first["hands"] == "right"
    assert first["mode"] == "live"
    assert first["duration_ms"] == 60000


def test_list_is_capped(tmp_path):
    ids = [save(tmp_path, "local:aaa", s)["id"] for s in range(12)]
    r = get(tmp_path, "/api/replay/attempts?score=local%3Aaaa")
    status, body = r.status, r.body
    assert status == 200
    items = json.loads(body)["attempts"]
    assert len(items) == 10
    assert items[0]["id"] == ids[-1]


def test_list_with_many_returns_ten_newest_without_list_attempts(tmp_path, monkeypatch):
    ids = [save(tmp_path, "local:aaa", s)["id"] for s in range(15)]

    def boom(*a, **k):
        raise AssertionError("list_attempts must not be called")

    monkeypatch.setattr(attempts, "list_attempts", boom)
    r = get(tmp_path, "/api/replay/attempts?score=local%3Aaaa")
    assert r.status == 200
    items = json.loads(r.body)["attempts"]
    assert [i["id"] for i in items] == list(reversed(ids))[:10]


def test_list_needs_score(tmp_path):
    r = get(tmp_path, "/api/replay/attempts")
    status, body = r.status, r.body
    assert status == 400
    assert json.loads(body)["error"] == "score is required"


def test_list_empty_folder(tmp_path):
    r = get(tmp_path, "/api/replay/attempts?score=local%3Aaaa")
    status, body = r.status, r.body
    assert status == 200
    assert json.loads(body) == {"attempts": []}
    assert (tmp_path / "attempts").exists() is False


def test_list_skips_broken_files(tmp_path):
    save(tmp_path, "local:aaa", 1)
    (tmp_path / "attempts" / "broken.json").write_text("{", encoding="utf-8")
    r = get(tmp_path, "/api/replay/attempts?score=local%3Aaaa")
    status, body = r.status, r.body
    assert status == 200
    assert len(json.loads(body)["attempts"]) == 1


def test_get_one_attempt(tmp_path):
    a = save(tmp_path, "local:aaa", 1)
    r = get(tmp_path, f"/api/replay/attempts/{a['id']}")
    status, body = r.status, r.body
    assert status == 200
    assert json.loads(body) == a


def test_bad_ids_are_400(tmp_path):
    for path in ("/api/replay/attempts/..%2Fsecret", "/api/replay/attempts/nope"):
        r = get(tmp_path, path)
        status, body = r.status, r.body
        assert status == 400
        assert json.loads(body)["error"] == "not an attempt id"


def test_missing_attempt_is_404(tmp_path):
    r = get(tmp_path, "/api/replay/attempts/attempt-20261106-090000-abcdef")
    status, body = r.status, r.body
    assert status == 404
    assert json.loads(body)["error"] == "no such attempt"


def test_unreadable_attempt_is_500(tmp_path):
    folder = tmp_path / "attempts"
    folder.mkdir(parents=True)
    (folder / "attempt-20261106-090000-abcdef.json").write_text("{", encoding="utf-8")
    r = get(tmp_path, "/api/replay/attempts/attempt-20261106-090000-abcdef")
    status, body = r.status, r.body
    assert status == 500
    assert "could not read the attempt" in json.loads(body)["error"]


def test_unknown_replay_routes_are_404(tmp_path):
    for path in ("/api/replay/nothing", "/api/replay"):
        status = get(tmp_path, path).status
        assert status == 404


def test_evil_host_is_403(tmp_path):
    status = get(tmp_path, "/api/replay/attempts?score=x", host="evil.example").status
    assert status == 403


def test_post_is_404(tmp_path):
    r = get(
        tmp_path,
        "/api/replay/attempts?score=x",
        method="POST",
        headers={"Host": "127.0.0.1:8765", "Origin": "http://localhost:5173"},
    )
    assert r.status == 404
