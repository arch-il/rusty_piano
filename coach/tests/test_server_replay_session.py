import json
import sys
from pathlib import Path
from urllib.parse import urlencode

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from mid_fixtures import engine_like, notes_to_events, smf, write  # noqa: E402

from rusty_piano_coach import compare  # noqa: E402
from rusty_piano_coach.cli import main  # noqa: E402
from rusty_piano_coach.jobs import Jobs  # noqa: E402
from rusty_piano_coach.library.index import Library  # noqa: E402
from rusty_piano_coach.server import handle_request  # noqa: E402

FIXTURE = Path(__file__).parent / "analysis_fixtures" / "analysis_repeat.musicxml"
SESSION = "session-20261104-220000.mid"


def good_bytes():
    expected, _, _ = compare.expected_notes(compare.load_score(FIXTURE))
    return engine_like(notes_to_events([(n.pitch, 1000 + 500 * n.q, 1400 + 500 * n.q, 64) for n in expected]))


@pytest.fixture
def env(tmp_path):
    lib = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(lib), "import", str(FIXTURE)]) == 0
    with Library(lib) as library:
        score_id = library.search(None, downloaded=True, limit=1)[0]["id"]
    sess = tmp_path / "sessions"
    sess.mkdir()
    write(sess / SESSION, good_bytes())
    return {"lib": lib, "sess": sess, "id": score_id, "tmp": tmp_path}


def get(env, path, method="GET", headers=None, sessions_dir=None):
    return handle_request(
        env["lib"],
        path,
        method,
        headers or {"Host": "127.0.0.1:8765"},
        Jobs(),
        attempts_dir=env["tmp"] / "attempts",
        sessions_dir=sessions_dir or env["sess"],
    )


def replay(env, **q):
    return get(env, "/api/replay/session?" + urlencode(q))


def test_list_sessions(env):
    write(env["sess"] / "session-20261105-080000.mid", good_bytes())
    (env["sess"] / "notes.txt").write_text("x", encoding="utf-8")
    (env["sess"] / "session-bad.mid").write_bytes(b"x")
    r = get(env, "/api/replay/sessions")
    assert r.status == 200
    items = json.loads(r.body)["sessions"]
    assert [i["name"] for i in items] == ["session-20261105-080000.mid", SESSION]
    assert items[0]["started_at"] == "2026-11-05T08:00:00Z"
    assert items[0]["size_bytes"] > 0


def test_list_sessions_missing_folder(env):
    none = env["tmp"] / "none"
    r = get(env, "/api/replay/sessions", sessions_dir=none)
    assert r.status == 200
    assert json.loads(r.body) == {"sessions": []}
    assert none.exists() is False


def test_session_replay_matches_the_score(env):
    r = replay(env, name=SESSION, score=env["id"])
    assert r.status == 200
    body = json.loads(r.body)
    assert body["kind"] == "rusty_piano.replay"
    assert body["summary"]["matched"] == 24
    rows = body["notes"]
    matches = [x for x in rows if x["kind"] == "match"]
    assert len(matches) == 24
    assert all(x["measure_index"] == x["bar"] - 1 for x in matches)
    assert {x["pass"] for x in rows if x["bar"] == 1} == {1, 2}
    assert body["window_ms"]["start"] == pytest.approx(500, abs=2)
    assert len(body["played"]) == 24
    assert body["played"][0]["on_ms"] == pytest.approx(500, abs=2)
    assert matches[0]["at_ms"] == pytest.approx(500, abs=2)
    assert body["duration_ms"] == pytest.approx(13900, abs=3)
    assert body["hands"] == "both"


def test_repeated_bar_numbers_helper():
    from rusty_piano_coach import replay

    assert replay.has_repeated_bar_numbers([(1, 1, 0, 4), (2, 1, 4, 4)]) is False
    assert replay.has_repeated_bar_numbers([(1, 1, 0, 4), (2, 1, 4, 4), (2, 1, 8, 4)]) is True


def test_repeated_bar_numbers_warns(env, monkeypatch):
    real = compare.load_score

    def patched(path):
        loaded = real(path)
        loaded.written_bars = list(loaded.written_bars) + [loaded.written_bars[0]]
        return loaded

    monkeypatch.setattr(compare, "load_score", patched)
    r = replay(env, name=SESSION, score=env["id"])
    assert r.status == 200
    assert (
        "this score repeats bar numbers (alternate endings?); marks may be placed in the wrong bar"
        in json.loads(r.body)["warnings"]
    )


def test_left_hand_has_no_notes(env):
    r = replay(env, name=SESSION, score=env["id"], hands="left")
    assert r.status == 422
    assert json.loads(r.body)["error"] == "this score has no notes for the chosen hands"


def test_bad_inputs(env):
    assert replay(env, name="../x.mid", score=env["id"]).status == 400
    assert replay(env, name="session-20261104-220000.txt", score=env["id"]).status == 400
    r = replay(env, name=SESSION)
    assert r.status == 400
    assert json.loads(r.body)["error"] == "score is required"
    assert replay(env, name=SESSION, score=env["id"], hands="feet").status == 400
    r = replay(env, name="session-20261231-235959.mid", score=env["id"])
    assert r.status == 404
    assert json.loads(r.body)["error"] == "no such session recording"
    r = replay(env, name=SESSION, score="local:nope")
    assert r.status == 404
    assert json.loads(r.body)["error"] == "score file not found"


def test_unrelated_recording(env):
    write(env["sess"] / SESSION, engine_like(notes_to_events([(30, 1000 + 500 * i, 1400 + 500 * i, 64) for i in range(10)])))
    r = replay(env, name=SESSION, score=env["id"])
    assert r.status == 422
    assert json.loads(r.body)["error"] == "none of this score's notes were found in this recording"


def test_empty_recording(env):
    write(env["sess"] / SESSION, smf([[(0, b"\xff\x51\x03\x07\xa1\x20")]]))
    r = replay(env, name=SESSION, score=env["id"])
    assert r.status == 422
    assert json.loads(r.body)["error"] == "this recording has no notes"


def test_corrupt_recording(env):
    write(env["sess"] / SESSION, b"MThd")
    r = replay(env, name=SESSION, score=env["id"])
    assert r.status == 400
    assert json.loads(r.body)["error"].startswith("could not read the recording")


def test_evil_host_is_403(env):
    r = get(env, "/api/replay/sessions", headers={"Host": "evil.example"})
    assert r.status == 403
