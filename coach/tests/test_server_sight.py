import json

from rusty_piano_coach import attempts
from rusty_piano_coach.server import handle_request


def sight_attempt(level, started_at):
    return {
        "version": 2,
        "kind": "rusty_piano.attempt",
        "score": {"id": "sight:" + level, "title": "Sight-reading", "composer": None},
        "mode": "wait",
        "end": "done",
        "started_at": started_at,
        "ended_at": "2026-11-06T20:00:05.000Z",
        "duration_ms": 5000,
        "clock": {"page_start_ms": 1000, "t0_ms": None, "first_engine_t": None, "first_engine_page_ms": None},
        "practice": {"hands": "right", "range": None, "loop": False, "loops_completed": 0},
        "plan": {"steps_total": 2, "length_quarters": 0, "first_bar": None, "last_bar": None},
        "settings": {"window_ms": 200},
        "autoplay": {"on_at_start": False, "used": False},
        "sources": ["engine"],
        "pedal_down_at_start": False,
        "steps": [
            {"step": 0, "card": 0, "notes": [60], "result": "hit", "first_try": True, "wrong_count": 0,
             "wrong_notes": [], "hinted": False, "reaction_ms": 900, "shown_page_ms": 1000, "done_page_ms": 1900},
            {"step": 1, "card": 1, "notes": [62], "result": "wrong", "first_try": False, "wrong_count": 1,
             "wrong_notes": [63], "hinted": True, "reaction_ms": 1100, "shown_page_ms": 2000, "done_page_ms": 3100},
        ],
        "events": [],
        "summary": {"counts": {}, "metrics": {}, "rows": []},
        "drill_id": None,
        "plan_id": None,
        "tags": ["sight-reading"],
    }


def plain_attempt():
    return {
        "version": 2,
        "kind": "rusty_piano.attempt",
        "score": {"id": "local:abc", "title": "Two", "composer": None},
        "mode": "live",
        "end": "done",
        "started_at": "2026-11-06T21:00:00.000Z",
        "ended_at": "2026-11-06T21:00:03.000Z",
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
        "drill_id": None,
        "plan_id": None,
        "tags": [],
    }


def get(tmp_path, path):
    return handle_request(
        tmp_path / "lib",
        path,
        "GET",
        None,
        attempts_dir=tmp_path / "attempts",
    )


def save_fixtures(tmp_path):
    folder = tmp_path / "attempts"
    attempts.save_attempt(folder, sight_attempt("r2-treble", "2026-11-06T20:00:00.000Z"))
    attempts.save_attempt(folder, sight_attempt("r3-bass", "2026-11-06T20:10:00.000Z"))
    attempts.save_attempt(folder, plain_attempt())


def test_history_lists_only_sight_rounds(tmp_path):
    save_fixtures(tmp_path)
    res = get(tmp_path, "/api/sight/history")
    assert res.status == 200
    rounds = json.loads(res.body)["rounds"]
    assert len(rounds) == 2
    assert sorted(r["level"] for r in rounds) == ["r2-treble", "r3-bass"]


def test_history_filters_by_level_and_returns_compact_fields(tmp_path):
    save_fixtures(tmp_path)
    res = get(tmp_path, "/api/sight/history?level=r2-treble")
    assert res.status == 200
    rounds = json.loads(res.body)["rounds"]
    assert len(rounds) == 1
    r = rounds[0]
    assert r["level"] == "r2-treble"
    assert r["started_at"] == "2026-11-06T20:00:00.000Z"
    assert r["drill_id"] is None
    assert r["end"] == "done"
    assert r["accuracy"] == 0.5
    assert r["median_ms"] == 1000
    assert r["steps"] == [
        {"notes": [60], "first_try": True, "reaction_ms": 900, "hinted": False, "wrong_count": 0},
        {"notes": [62], "first_try": False, "reaction_ms": 1100, "hinted": True, "wrong_count": 1},
    ]


def test_empty_folder_gives_no_rounds(tmp_path):
    res = get(tmp_path, "/api/sight/history")
    assert res.status == 200
    assert json.loads(res.body) == {"rounds": []}


def test_bad_level_is_400_with_the_error_text(tmp_path):
    res = get(tmp_path, "/api/sight/history?level=Bad!")
    assert res.status == 400
    assert json.loads(res.body) == {"error": "level must be a short lowercase id like r2-treble"}


def test_get_attempts_is_still_405(tmp_path):
    res = get(tmp_path, "/api/attempts")
    assert res.status == 405
