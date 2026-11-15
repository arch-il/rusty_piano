import json
from pathlib import Path

import evidence_fixtures as fx

from rusty_piano_coach import attempts, attempts_cli
from rusty_piano_coach.attempts import started_key
from rusty_piano_coach.cli import main

FIX = Path(__file__).parent / "analysis_fixtures"


def two_attempts(folder):
    a = fx.make_attempt(id="attempt-20261105-070000-aaaaaa", started_at="2026-11-05T09:00:00+00:00")
    b = fx.make_attempt(id="attempt-20261105-080000-bbbbbb", started_at="2026-11-05T08:00:00+00:00")
    fx.write_attempts(folder, [a, b])
    return a, b


def test_latest_uses_started_at_not_save_order(tmp_path):
    folder = tmp_path / "attempts"
    a, _ = two_attempts(folder)
    assert attempts.load_attempt(folder, "latest")["id"] == a["id"]
    assert attempts.load_attempt_file(folder, "latest")[1].name == "attempt-20261105-070000-aaaaaa.json"


def test_started_key_compares_offsets():
    assert started_key({"started_at": "2026-11-05T10:00:00+02:00"}) < started_key({"started_at": "2026-11-05T09:00:00+00:00"})
    assert started_key({"id": "x"}) < started_key({"started_at": "2026-11-05T09:00:00+00:00"})
    assert started_key({"started_at": "not a time"}) < started_key({"started_at": "2026-11-05T09:00:00+00:00"})


def test_list_and_show_latest_agree(tmp_path, capsys):
    folder = tmp_path / "attempts"
    a, _ = two_attempts(folder)
    assert main(["attempts", "list", "--json", "--attempts-dir", str(folder)]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert main(["attempts", "show", "latest", "--json", "--attempts-dir", str(folder)]) == 0
    shown = json.loads(capsys.readouterr().out)
    assert rows[0]["id"] == a["id"]
    assert shown["id"] == a["id"]


def test_bars_wording():
    assert attempts_cli._bars({"range": {"from": 1, "to": 1}, "loop": False}) == "from 1"
    assert attempts_cli._bars({"range": {"from": 1, "to": 1}, "loop": True}) == "1 loop"
    assert attempts_cli._bars({"range": {"from": 3, "to": 5}, "loop": False}) == "3-5"
    assert attempts_cli._bars({"range": None, "loop": False}) == "All"


def test_analyse_latest_without_id_names_the_file(tmp_path, capsys):
    folder = tmp_path / "attempts"
    folder.mkdir()
    obj = fx.make_attempt()
    obj.pop("id")
    (folder / "attempt-20261105-070000-abcdef.json").write_text(json.dumps(obj), encoding="utf-8")
    code = main([
        "analyse", "--attempt", "latest", "--attempts-dir", str(folder),
        "--sessions-dir", str(tmp_path / "sessions"), "--reports-dir", str(tmp_path / "reports"),
        "--score-file", str(FIX / "analysis_repeat.musicxml"),
    ])
    err = capsys.readouterr().err
    assert code == 1
    assert "attempt-20261105-070000-abcdef.json is missing id" in err
    assert "latest.json" not in err
    assert "Traceback" not in err


def test_show_latest_without_id_names_the_file(tmp_path, capsys):
    folder = tmp_path / "attempts"
    folder.mkdir()
    obj = fx.make_attempt()
    obj.pop("id")
    (folder / "attempt-20261105-070000-abcdef.json").write_text(json.dumps(obj), encoding="utf-8")
    code = main(["attempts", "show", "latest", "--attempts-dir", str(folder)])
    err = capsys.readouterr().err
    assert code == 1
    assert "attempt-20261105-070000-abcdef.json is missing id" in err
