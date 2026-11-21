import sqlite3

import pytest

import evidence_fixtures
from rusty_piano_coach import cli
from rusty_piano_coach.cli import main


@pytest.fixture
def corrupt(tmp_path, monkeypatch):
    d = tmp_path / "lib"
    d.mkdir()
    (d / "library.sqlite").write_bytes(b"garbage, not a database " * 50)
    monkeypatch.setenv("RUSTY_PIANO_SCORES_DIR", str(d))
    return d


def analyse_argv(d, tmp_path):
    evidence_fixtures.write_attempts(tmp_path / "att", [evidence_fixtures.make_attempt(score="gen:t1-quarters-rh")])
    return [
        "analyse",
        "--attempt",
        "latest",
        "--score",
        "gen:t1-quarters-rh",
        "--data-dir",
        str(d),
        "--attempts-dir",
        str(tmp_path / "att"),
        "--sessions-dir",
        str(tmp_path / "ses"),
        "--reports-dir",
        str(tmp_path / "rep"),
    ]


CASES = [
    ["scores", "list"],
    ["scores", "search", "piano"],
    ["scores", "show", "1"],
    ["scores", "sources"],
    ["fingering"],
]


@pytest.mark.parametrize("argv", CASES, ids=lambda a: " ".join(a))
def test_corrupt_library_one_line_error(corrupt, capsys, argv):
    assert main([*argv, "--data-dir", str(corrupt)]) == 1
    captured = capsys.readouterr()
    assert "library.sqlite" in captured.err
    assert "damaged" in captured.err
    assert "Traceback" not in captured.out + captured.err


def test_analyse_corrupt_library_one_line_error(corrupt, tmp_path, capsys):
    assert main(analyse_argv(corrupt, tmp_path)) == 1
    captured = capsys.readouterr()
    assert "library.sqlite" in captured.err
    assert "damaged" in captured.err
    assert "Traceback" not in captured.out + captured.err


def test_locked_library_is_not_reported_as_damaged(corrupt, monkeypatch):
    def locked(args):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(cli, "run_fingering", locked)
    with pytest.raises(sqlite3.OperationalError):
        main(["fingering", "--data-dir", str(corrupt)])
