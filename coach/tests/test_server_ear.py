import json

from rusty_piano_coach import attempts
from rusty_piano_coach.server import handle_request


def ear_attempt(level, started_at):
    return {
        "version": 2,
        "kind": "rusty_piano.attempt",
        "score": {"id": "ear:" + level, "title": "Ear training", "composer": None},
        "mode": "wait",
        "end": "done",
        "started_at": started_at,
        "ended_at": "2026-11-08T10:00:05.000Z",
        "duration_ms": 5000,
        "clock": {"page_start_ms": 1000, "t0_ms": None, "first_engine_t": None, "first_engine_page_ms": None},
        "practice": {"hands": "both", "range": None, "loop": False, "loops_completed": 0},
        "plan": {"steps_total": 2, "length_quarters": 0, "first_bar": None, "last_bar": None},
        "settings": {"ear": {"seed": 1, "reveal_after": 3, "sound": "engine", "counted": True}},
        "autoplay": {"on_at_start": False, "used": False},
        "sources": ["engine"],
        "pedal_down_at_start": False,
        "ear": {
            "level": level,
            "type": "echo",
            "node": "E1",
            "kind": "note",
            "items_total": 2,
            "items_done": 2,
            "first_try": 2,
            "replays": 1,
            "revealed": 0,
            "median_step_ms": 1800,
            "targets_ms": {"good": 5000, "solid": 3000, "mastered": 2000},
            "sound": "engine",
        },
        "steps": [
            {"step": 0, "item": 0, "type": "echo", "category": "C4", "label": "C4", "prompt_notes": [60],
             "given": [], "answer_notes": [60], "answer_steps": 1, "result": "hit", "first_try": True,
             "wrong_count": 0, "wrong_notes": [], "replays": 1, "revealed": False, "response_ms": 1800,
             "asked_page_ms": 2000, "done_page_ms": 3800},
            {"step": 1, "item": 1, "type": "echo", "category": "E4", "label": "E4", "prompt_notes": [64],
             "given": [], "answer_notes": [64], "answer_steps": 1, "result": "hit", "first_try": True,
             "wrong_count": 0, "wrong_notes": [], "replays": 0, "revealed": False, "response_ms": 2200,
             "asked_page_ms": 4000, "done_page_ms": 6200},
        ],
        "events": [],
        "summary": {"counts": {}, "metrics": {}, "rows": []},
        "drill_id": "ear." + level,
        "plan_id": None,
        "tags": ["ear-training"],
    }


def get(tmp_path, path, headers=None):
    return handle_request(
        tmp_path / "lib",
        path,
        "GET",
        headers,
        attempts_dir=tmp_path / "attempts",
    )


def test_host_guard_refuses_other_hosts(tmp_path):
    res = get(tmp_path, "/api/ear/history", {"Host": "evil.example:8765"})
    assert res.status == 403


def test_bad_level_is_400_with_the_error_text(tmp_path):
    res = get(tmp_path, "/api/ear/history?level=Bad!")
    assert res.status == 400
    assert json.loads(res.body) == {"error": "level must be a short lowercase id like echo-1"}


def test_empty_history(tmp_path):
    res = get(tmp_path, "/api/ear/history")
    assert res.status == 200
    assert json.loads(res.body) == {"rounds": []}


def test_saved_ear_attempt_shows_up_with_its_fields(tmp_path):
    attempts.save_attempt(tmp_path / "attempts", ear_attempt("echo-1", "2026-11-08T10:00:00.000Z"))
    res = get(tmp_path, "/api/ear/history")
    assert res.status == 200
    rounds = json.loads(res.body)["rounds"]
    assert len(rounds) == 1
    r = rounds[0]
    assert r["level"] == "echo-1"
    assert r["started_at"] == "2026-11-08T10:00:00.000Z"
    assert r["drill_id"] == "ear.echo-1"
    assert r["end"] == "done"
    assert r["accuracy"] == 1.0
    assert r["median_step_ms"] == 2000
    assert r["replays"] == 1
    assert [i["category"] for i in r["items"]] == ["C4", "E4"]


def test_level_filter(tmp_path):
    attempts.save_attempt(tmp_path / "attempts", ear_attempt("echo-1", "2026-11-08T10:00:00.000Z"))
    attempts.save_attempt(tmp_path / "attempts", ear_attempt("chord-1", "2026-11-08T11:00:00.000Z"))
    res = get(tmp_path, "/api/ear/history?level=chord-1")
    assert res.status == 200
    rounds = json.loads(res.body)["rounds"]
    assert [r["level"] for r in rounds] == ["chord-1"]


def test_history_does_not_create_folders(tmp_path):
    res = get(tmp_path, "/api/ear/history")
    assert res.status == 200
    assert not (tmp_path / "attempts").exists()
    assert not (tmp_path / "lib").exists()
