import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from mid_fixtures import engine_like, notes_to_events, write  # noqa: E402

from rusty_piano_coach import attempts, compare  # noqa: E402
from rusty_piano_coach.cli import main  # noqa: E402
from rusty_piano_coach.library.index import Library  # noqa: E402

FIXTURE = Path(__file__).parent / "analysis_fixtures" / "analysis_repeat.musicxml"
SESSION = "session-20261104-220000.mid"


def expected_played():
    expected, _, _ = compare.expected_notes(compare.load_score(FIXTURE))
    return expected


def session_notes():
    return [(n.pitch, 1000 + 500 * n.q, 1400 + 500 * n.q, 64) for n in expected_played()]


@pytest.fixture
def env(tmp_path):
    lib = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(lib), "import", str(FIXTURE)]) == 0
    with Library(lib) as library:
        score_id = library.search(None, downloaded=True, limit=1)[0]["id"]
    sess = tmp_path / "sessions"
    sess.mkdir()
    write(sess / SESSION, engine_like(notes_to_events(session_notes())))
    return {
        "lib": str(lib), "sess": str(sess), "att": str(tmp_path / "attempts"), "rep": str(tmp_path / "reports"),
        "id": score_id, "tmp": tmp_path,
    }


def dirs(env):
    return ["--data-dir", env["lib"], "--sessions-dir", env["sess"], "--attempts-dir", env["att"],
            "--reports-dir", env["rep"]]


def only_report(env):
    files = list(Path(env["rep"]).glob("report-*.json"))
    assert len(files) == 1
    return json.loads(files[0].read_text(encoding="utf-8")), files[0]


def attempt_dict(env, events, **practice):
    p = {"hands": "both", "range": None, "loop": False, "loops_completed": 0,
         "tempo": {"percent": 100, "bpm": 120, "start_bpm": 120}}
    p.update(practice)
    return {
        "version": 1, "kind": "rusty_piano.attempt", "score": {"id": env["id"], "title": "Two"},
        "mode": "live", "end": "done", "started_at": "2026-11-04T22:00:30Z", "duration_ms": 12000,
        "sources": ["engine"], "pedal_down_at_start": False, "practice": p, "steps": [], "events": events,
        "summary": {"counts": {"correctNotes": 24, "missedNotes": 0, "wrongNotes": 0}, "metrics": {}, "rows": []},
    }


def engine_events(notes, shift=0):
    events = []
    for pitch, start, end, velocity in notes:
        events.append({"type": "note_on", "t": start + shift, "page_ms": start, "source": "engine",
                       "note": pitch, "velocity": velocity})
        events.append({"type": "note_off", "t": end + shift, "page_ms": end, "source": "engine", "note": pitch})
    return events


def test_midi_latest(env, capsys):
    code = main(["analyse", "latest", "--score", env["id"], *dirs(env)])
    out = capsys.readouterr().out
    assert code == 0
    assert "Report:" in out and "Summary:" in out
    report, path = only_report(env)
    assert report["version"] == 1
    assert report["input"]["kind"] == "midi"
    assert report["input"]["session_started_at"] == "2026-11-04T22:00:00Z"
    assert report["summary"]["matched"] == 24
    assert report["expansion"]["play_order"] == [1, 2, 1, 2, 3, 4]
    assert path.with_suffix(".md").exists()


def test_score_file(env, capsys):
    code = main(["analyse", "latest", "--score-file", str(FIXTURE), *dirs(env)])
    assert code == 0
    report, _ = only_report(env)
    assert report["score"]["id"] is None
    assert report["summary"]["matched"] == 24


def test_json_output(env, capsys):
    code = main(["analyse", "latest", "--score", env["id"], "--json", *dirs(env)])
    assert code == 0
    assert json.loads(capsys.readouterr().out)["kind"] == "rusty_piano.report"


def test_bars_option(env, capsys):
    code = main(["analyse", "latest", "--score", env["id"], "--bars", "1-2", *dirs(env)])
    assert code == 0
    report, _ = only_report(env)
    assert report["options"]["bars"] == {"from": 1, "to": 2}
    assert report["expansion"]["method"] == "bar-range"


def test_attempt_matches_session(env, capsys):
    attempts.save_attempt(Path(env["att"]), attempt_dict(env, engine_events(session_notes())))
    code = main(["analyse", "--attempt", "latest", *dirs(env)])
    assert code == 0
    report, _ = only_report(env)
    assert report["input"]["kind"] == "attempt"
    assert report["input"]["midi_path"].endswith(SESSION)
    assert report["summary"]["matched"] == 24
    assert report["attempt_summary"]["correctNotes"] == 24


def test_attempt_engine_time_one_ms_late(env, capsys):
    notes = session_notes()
    attempts.save_attempt(Path(env["att"]), attempt_dict(env, engine_events(notes, shift=1)))
    assert main(["analyse", "--attempt", "latest", *dirs(env)]) == 0
    report, _ = only_report(env)
    assert report["input"]["kind"] == "attempt"
    assert report["summary"]["matched"] == len(notes)


def test_attempt_own_events(env, capsys):
    events = [{"type": "note_on", "t": 100, "page_ms": 1000 + 500 * i, "source": "autoplay", "note": n.pitch,
               "velocity": 64} for i, n in enumerate(expected_played())]
    attempts.save_attempt(Path(env["att"]), attempt_dict(env, events))
    assert main(["analyse", "--attempt", "latest", *dirs(env)]) == 0
    report, _ = only_report(env)
    assert report["input"]["kind"] == "attempt-events"
    assert report["input"]["time_base"] == "page"
    assert any("own events" in w for w in report["warnings"])


def test_input_errors(env, capsys):
    assert main(["analyse", "--score", env["id"], *dirs(env)]) == 2
    assert main(["analyse", "latest", "--attempt", "latest", "--score", env["id"], *dirs(env)]) == 2
    assert main(["analyse", "latest", *dirs(env)]) == 2


def test_window_with_attempt_is_an_error(env, capsys):
    capsys.readouterr()
    assert main(["analyse", "--attempt", "latest", "--start-ms", "5", *dirs(env)]) == 2
    assert "only work with a .mid" in capsys.readouterr().err


def test_lookup_and_file_errors(env, capsys):
    assert main(["analyse", "latest", "--score", "nope", *dirs(env)]) == 1
    assert "error:" in capsys.readouterr().err
    assert main(["analyse", str(env["tmp"] / "missing.mid"), "--score", env["id"], *dirs(env)]) == 1
    assert "error:" in capsys.readouterr().err


def test_incomplete_attempt_says_what_is_missing(env, capsys):
    folder = Path(env["att"])
    folder.mkdir()
    minimal = {"version": 1, "kind": "rusty_piano.attempt", "id": "attempt-20261105-070000-aaaaaa",
               "score": {"id": "x"}, "mode": "live", "end": "done", "started_at": "2026-11-05T07:00:00Z",
               "steps": [], "events": [], "summary": {}}
    (folder / "attempt-20261105-070000-aaaaaa.json").write_text(json.dumps(minimal), encoding="utf-8")
    code = main(["analyse", "--attempt", "latest", "--score-file", str(FIXTURE), *dirs(env)])
    err = capsys.readouterr().err
    assert code == 1
    assert "attempt-20261105-070000-aaaaaa.json is missing practice" in err
    assert "Traceback" not in err
