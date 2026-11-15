import json
from pathlib import Path

from rusty_piano_coach.server import body_limit, handle_request, make_server

HEADERS = {
    "Host": "127.0.0.1:8765",
    "Origin": "http://localhost:5173",
    "Content-Type": "application/json; charset=utf-8",
}


def attempt_body(**over) -> bytes:
    attempt = {
        "version": 1,
        "kind": "rusty_piano.attempt",
        "score": {"id": "local:abc", "title": "Two", "composer": None},
        "mode": "live",
        "end": "done",
        "started_at": "2026-11-05T07:00:00.000Z",
        "ended_at": "2026-11-05T07:00:03.000Z",
        "duration_ms": 3000,
        "clock": {"page_start_ms": 1000, "t0_ms": 2000, "first_engine_t": 500, "first_engine_page_ms": 2010},
        "practice": {"hands": "both", "range": None, "loop": False, "loops_completed": 0},
        "plan": {"steps_total": 1, "length_quarters": 1, "first_bar": 1, "last_bar": 1},
        "settings": {"window_ms": 200},
        "autoplay": {"on_at_start": False, "used": False},
        "sources": ["engine"],
        "pedal_down_at_start": False,
        "steps": [],
        "events": [{"type": "note_on", "t": 500, "page_ms": 2010, "source": "engine", "note": 60, "velocity": 100}],
        "summary": {"counts": {}, "metrics": {}, "rows": []},
    }
    attempt.update(over)
    return json.dumps(attempt).encode("utf-8")


def post(tmp_path: Path, body: bytes, headers=None, folder=None):
    return handle_request(
        tmp_path / "lib",
        "/api/attempts",
        "POST",
        dict(HEADERS) if headers is None else headers,
        body=body,
        attempts_dir=folder if folder is not None else tmp_path / "attempts",
    )


def test_post_saves_the_attempt_and_answers_201(tmp_path):
    res = post(tmp_path, attempt_body())
    assert res.status == 201
    data = json.loads(res.body)
    assert data["file"] == data["id"] + ".json"
    assert (tmp_path / "attempts" / data["file"]).is_file()


def test_post_from_another_origin_is_refused_and_writes_nothing(tmp_path):
    res = post(tmp_path, attempt_body(), headers={**HEADERS, "Origin": "http://evil.example"})
    assert res.status == 403
    assert not (tmp_path / "attempts").exists()


def test_post_without_host_is_refused(tmp_path):
    res = post(tmp_path, attempt_body(), headers={**HEADERS, "Host": None})
    assert res.status == 403
    assert not (tmp_path / "attempts").exists()


def test_post_with_wrong_content_type_is_415(tmp_path):
    res = post(tmp_path, attempt_body(), headers={**HEADERS, "Content-Type": "text/plain"})
    assert res.status == 415
    assert json.loads(res.body) == {"error": "send the attempt as application/json"}


def test_post_with_invalid_json_is_400(tmp_path):
    res = post(tmp_path, b"{")
    assert res.status == 400
    assert json.loads(res.body) == {"error": "attempt is not valid JSON"}


def test_post_with_version_3_is_400(tmp_path):
    res = post(tmp_path, attempt_body(version=3))
    assert res.status == 400
    assert json.loads(res.body) == {"error": "unsupported attempt version (expected 1 or 2)"}


def test_post_version_2_saves_the_drill_fields(tmp_path):
    res = post(tmp_path, attempt_body(version=2, drill_id="r2.steps", plan_id=None, tags=["fun"]))
    assert res.status == 201
    data = json.loads(res.body)
    saved = json.loads((tmp_path / "attempts" / data["file"]).read_text(encoding="utf-8"))
    assert saved["version"] == 2
    assert saved["tags"] == ["fun"]


def test_get_attempts_is_405(tmp_path):
    res = handle_request(tmp_path / "lib", "/api/attempts", "GET", {"Host": "127.0.0.1"})
    assert res.status == 405
    assert json.loads(res.body) == {"error": "use POST for this"}


def test_body_limit_is_only_large_for_attempts():
    assert body_limit("/api/attempts") == 20_000_000
    assert body_limit("/api/scores/x/delete") == 1_000_000


def test_post_without_attempts_dir_uses_the_data_dir_env(tmp_path):
    res = handle_request(tmp_path / "lib", "/api/attempts", "POST", dict(HEADERS), body=attempt_body())
    assert res.status == 201
    data = json.loads(res.body)
    assert (tmp_path / "default_data" / "attempts" / data["file"]).is_file()


def test_make_server_takes_an_attempts_dir(tmp_path):
    server = make_server(tmp_path / "lib", 0, attempts_dir=tmp_path / "a")
    try:
        assert server.attempts_dir == tmp_path / "a"
    finally:
        server.server_close()
