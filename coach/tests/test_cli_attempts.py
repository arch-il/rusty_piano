import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from rusty_piano_coach import attempts
from rusty_piano_coach.cli import main


def valid_attempt(**over):
    attempt = {
        "version": 1,
        "kind": "rusty_piano.attempt",
        "score": {"id": "local:abc", "title": "Two"},
        "mode": "live",
        "end": "done",
        "started_at": "2026-11-05T07:00:00.000Z",
        "duration_ms": 3000,
        "sources": ["engine"],
        "pedal_down_at_start": False,
        "practice": {
            "hands": "both",
            "range": None,
            "loop": False,
            "loops_completed": 0,
            "tempo": {"percent": 100, "bpm": 120, "start_bpm": 120},
        },
        "steps": [
            {
                "cycle": 1,
                "step": 0,
                "bar": 1,
                "beat": 0,
                "pass": 1,
                "expected": [60],
                "result": "hit",
                "offset_ms": 10,
                "wrong": [],
                "holds": [],
            }
        ],
        "events": [],
        "summary": {"metrics": {"accuracy": "70%", "tempo": "100%"}, "rows": [["Accuracy", "70%"], ["Wrong", "0"]]},
    }
    attempt.update(over)
    return attempt


WRONG_STEP = {
    "cycle": 1,
    "step": 1,
    "bar": 2,
    "beat": 0,
    "pass": 1,
    "expected": [62],
    "result": "wrong",
    "offset_ms": None,
    "wrong": [{"note": 61, "page_ms": 2100}],
    "holds": [],
}


@pytest.fixture
def folder(tmp_path):
    d = tmp_path / "attempts"
    attempts.save_attempt(
        d,
        valid_attempt(started_at="2026-11-05T07:00:00.000Z", score={"id": "local:two", "title": "Two"}),
        now=datetime(2026, 11, 5, 7, 0, 0, tzinfo=timezone.utc),
    )
    attempts.save_attempt(
        d,
        valid_attempt(
            started_at="2026-11-05T08:00:00.000Z",
            score={"id": "local:three", "title": "Three"},
            summary={"metrics": {"accuracy": "92%", "tempo": "100%"}, "rows": [["Accuracy", "92%"]]},
            steps=[WRONG_STEP],
        ),
        now=datetime(2026, 11, 5, 8, 0, 0, tzinfo=timezone.utc),
    )
    return d


def stored_ids(folder):
    return sorted(p.stem for p in Path(folder).glob("*.json"))


def newest_and_oldest(folder):
    ids = stored_ids(folder)
    return ids[-1], ids[0]


def test_list_shows_newest_first(folder, capsys):
    assert main(["attempts", "list", "--attempts-dir", str(folder)]) == 0
    out = capsys.readouterr().out
    newer, older = newest_and_oldest(folder)
    assert newer in out and older in out
    assert out.index(newer) < out.index(older)
    assert "92%" in out


def test_list_json(folder, capsys):
    assert main(["attempts", "list", "--attempts-dir", str(folder), "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert isinstance(rows, list) and len(rows) == 2
    assert set(rows[0]) == {
        "id",
        "started_at",
        "mode",
        "end",
        "score_id",
        "title",
        "bars",
        "hands",
        "accuracy",
        "tempo",
        "sources",
        "duration_ms",
    }
    assert rows[0]["title"] == "Three"
    assert rows[0]["accuracy"] == "92%"
    assert rows[0]["bars"] is None


def test_list_limit_one(folder, capsys):
    assert main(["attempts", "list", "--attempts-dir", str(folder), "--limit", "1"]) == 0
    out = capsys.readouterr().out
    newer, older = newest_and_oldest(folder)
    assert newer in out
    assert older not in out


def test_list_empty_folder(tmp_path, capsys):
    assert main(["attempts", "list", "--attempts-dir", str(tmp_path / "none")]) == 0
    assert "No attempts saved yet" in capsys.readouterr().out


def test_list_warns_about_broken_file(folder, capsys):
    (folder / "broken.json").write_text("not json", encoding="utf-8")
    assert main(["attempts", "list", "--attempts-dir", str(folder)]) == 0
    captured = capsys.readouterr()
    assert "warning: skipped" in captured.err
    assert "Three" in captured.out


MINIMAL_ID = "attempt-20261105-070000-aaaaaa"


def write_minimal(folder):
    (folder / f"{MINIMAL_ID}.json").write_text(
        json.dumps({"version": 1, "kind": "rusty_piano.attempt", "id": MINIMAL_ID}), encoding="utf-8"
    )


def test_list_skips_incomplete_version_1_file(folder, capsys):
    write_minimal(folder)
    assert main(["attempts", "list", "--attempts-dir", str(folder)]) == 0
    captured = capsys.readouterr()
    assert any(line.startswith(f"warning: skipped {MINIMAL_ID}.json") for line in captured.err.splitlines())
    assert "Three" in captured.out
    assert MINIMAL_ID not in captured.out


def test_show_incomplete_version_1_file_errors_cleanly(folder, capsys):
    write_minimal(folder)
    assert main(["attempts", "show", MINIMAL_ID, "--attempts-dir", str(folder)]) == 1
    err = capsys.readouterr().err
    assert err.startswith(f"error: {MINIMAL_ID}.json")
    assert "Traceback" not in err


def test_wrong_typed_fields_do_not_crash(folder, capsys):
    (folder / f"{MINIMAL_ID}.json").write_text(
        json.dumps(valid_attempt(id=MINIMAL_ID, practice="x", steps=5)), encoding="utf-8"
    )
    assert main(["attempts", "list", "--attempts-dir", str(folder)]) == 0
    captured = capsys.readouterr()
    assert "warning: skipped" in captured.err
    assert "Three" in captured.out
    assert main(["attempts", "show", MINIMAL_ID, "--attempts-dir", str(folder)]) == 1
    assert capsys.readouterr().err.startswith("error:")


def test_show_latest(folder, capsys):
    assert main(["attempts", "show", "latest", "--attempts-dir", str(folder)]) == 0
    out = capsys.readouterr().out
    assert "Summary:" in out
    assert any("bar 2" in line and "C#4" in line for line in out.splitlines())


def test_show_by_unique_prefix(folder, capsys):
    newer, older = newest_and_oldest(folder)
    assert main(["attempts", "show", older[:21], "--attempts-dir", str(folder)]) == 0
    out = capsys.readouterr().out
    assert f"Attempt {older}" in out


def test_show_unknown_id(folder, capsys):
    assert main(["attempts", "show", "nope", "--attempts-dir", str(folder)]) == 1
    assert "error:" in capsys.readouterr().err


def test_show_json_equals_stored_file(folder, capsys):
    newer, _ = newest_and_oldest(folder)
    assert main(["attempts", "show", newer, "--attempts-dir", str(folder), "--json"]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert shown == json.loads((folder / f"{newer}.json").read_text(encoding="utf-8"))


def test_serve_help_lists_attempts_dir(capsys):
    with pytest.raises(SystemExit) as e:
        main(["serve", "--help"])
    assert e.value.code == 0
    assert "--attempts-dir" in capsys.readouterr().out


def test_gitignore_and_readme_present():
    root = Path(__file__).parents[2]
    text = (root / ".gitignore").read_text(encoding="utf-8")
    assert "coach/data/attempts/*" in text.splitlines()
    assert "!coach/data/attempts/README.md" in text.splitlines()
    assert (root / "coach" / "data" / "attempts" / "README.md").is_file()


FIXTURES = Path(__file__).resolve().parents[1] / "web" / "tests" / "fixtures"


def save_fixture(tmp_path, name, mutate=None):
    a = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    if mutate:
        mutate(a)
    d = tmp_path / "attempts"
    attempts.save_attempt(d, a, now=datetime(2026, 11, 8, 10, 0, 30, tzinfo=timezone.utc))
    return d


def test_show_ear_attempt(tmp_path, capsys):
    d = save_fixture(tmp_path, "ear-attempt.json")
    assert main(["attempts", "show", "latest", "--attempts-dir", str(d)]) == 0
    out = capsys.readouterr().out
    assert "ear:echo-1" in out
    assert "Tempo: 100% \u00b7 start - bpm" in out
    assert "echo-1" in out and "3 of 3" in out and "2.4 s" in out


def test_show_ear_attempt_with_wrong_step(tmp_path, capsys):
    def mutate(a):
        a["steps"][1].update(result="wrong", first_try=False, wrong_count=1, wrong_notes=[62])
        a["ear"]["first_try"] = 2

    d = save_fixture(tmp_path, "ear-attempt.json", mutate)
    assert main(["attempts", "show", "latest", "--attempts-dir", str(d)]) == 0
    out = capsys.readouterr().out
    assert "2 of 3" in out


def test_show_sight_attempt(tmp_path, capsys):
    def mutate(a):
        a["steps"][1].update(result="wrong", first_try=False, wrong_count=1, wrong_notes=[62])

    d = save_fixture(tmp_path, "sight-attempt.json", mutate)
    assert main(["attempts", "show", "latest", "--attempts-dir", str(d)]) == 0
    assert "sight:r2-treble" in capsys.readouterr().out
