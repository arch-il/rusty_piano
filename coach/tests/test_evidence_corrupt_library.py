import json
import sqlite3

import pytest

import evidence_fixtures
from rusty_piano_coach.cli import main
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.score_notes import evidence_block


def corrupt_dir(tmp_path):
    d = tmp_path / "lib"
    d.mkdir()
    (d / "library.sqlite").write_bytes(b"this is not a sqlite database " * 50)
    return d


def evidence_args(d, tmp_path):
    return [
        "evidence",
        "--json",
        "--all",
        "--data-dir",
        str(d),
        "--attempts-dir",
        str(tmp_path / "attempts"),
        "--reports-dir",
        str(tmp_path / "reports"),
        "--plan-dir",
        str(tmp_path / "plan"),
        "--sessions-dir",
        str(tmp_path / "sessions"),
    ]


def test_evidence_block_corrupt(tmp_path):
    d = corrupt_dir(tmp_path)
    assert evidence_block(d) == {}


def test_cli_evidence_corrupt_library(tmp_path, capsys):
    d = corrupt_dir(tmp_path)
    assert main(evidence_args(d, tmp_path)) == 0
    assert json.loads(capsys.readouterr().out)["score_notes"] == {}


def test_cli_evidence_corrupt_library_with_attempt(tmp_path, capsys):
    d = corrupt_dir(tmp_path)
    attempt = evidence_fixtures.make_attempt(score="gen:t1-quarters-rh")
    evidence_fixtures.write_attempts(tmp_path / "attempts", [attempt])
    assert main(evidence_args(d, tmp_path)) == 0
    assert json.loads(capsys.readouterr().out)["score_notes"] == {}


def test_library_closes_on_open_error(tmp_path):
    d = corrupt_dir(tmp_path)
    with pytest.raises(sqlite3.DatabaseError):
        Library(d)
    (d / "library.sqlite").unlink()
