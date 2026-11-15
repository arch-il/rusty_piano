import tomllib
from pathlib import Path

import pytest

from rusty_piano_coach.cli import main
from rusty_piano_coach.library.index import Library


@pytest.fixture
def imported(tmp_path, fixtures_dir, capsys):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(fixtures_dir)]) == 0
    return d, capsys.readouterr().out


def run(capsys, d, *args):
    code = main(["scores", "--data-dir", str(d), *args])
    return code, capsys.readouterr()


def test_import(imported):
    d, out = imported
    assert "imported" in out and "Simple C Major" in out and "Two Hands" in out
    assert "skipped" in out
    assert "Imported 2, skipped 1, already had 0." in out
    assert len(list((d / "files" / "local").iterdir())) == 2


def test_import_twice(imported, capsys, fixtures_dir):
    d, _ = imported
    code, cap = run(capsys, d, "import", str(fixtures_dir))
    assert code == 0
    assert "already in library" in cap.out and "already had 2" in cap.out


def test_search_text(imported, capsys):
    d, _ = imported
    out = run(capsys, d, "search", "two")[1].out
    assert "Two Hands" in out and "Simple C Major" not in out


def test_search_filters(imported, capsys):
    d, _ = imported
    out = run(capsys, d, "search", "--key", "E minor")[1].out
    assert "Two Hands" in out and "Simple C Major" not in out
    out = run(capsys, d, "search", "--time", "4/4")[1].out
    assert "Simple C Major" in out and "Two Hands" not in out
    out = run(capsys, d, "search", "--difficulty", "1")[1].out
    assert "Simple C Major" in out and "Two Hands" not in out


def test_search_none(imported, capsys):
    d, _ = imported
    assert "No scores found." in run(capsys, d, "search", "zzzz")[1].out


def test_list(imported, capsys):
    d, _ = imported
    out = run(capsys, d, "list")[1].out
    assert "Simple C Major" in out and "Two Hands" in out and "2 score(s) in your library" in out


def test_show(imported, capsys):
    d, _ = imported
    with Library(d) as lib:
        num = lib.search("two")[0]["num"]
    code, cap = run(capsys, d, "show", str(num))
    assert code == 0
    assert "Key: E minor" in cap.out
    assert "Time signature: 3/4" in cap.out
    assert "Difficulty: 2 (from score)" in cap.out


def test_sync_local(imported, capsys):
    d, _ = imported
    code, cap = run(capsys, d, "sync", "local")
    assert code == 1 and "has no online catalogue" in cap.err


def test_errors(imported, capsys, tmp_path):
    d, _ = imported
    code, cap = run(capsys, d, "show", "999")
    assert code == 1 and "error:" in cap.err
    code, cap = run(capsys, d, "import", str(tmp_path / "missing.musicxml"))
    assert code == 1


def test_bad_difficulty(tmp_path):
    with pytest.raises(SystemExit):
        main(["scores", "--data-dir", str(tmp_path), "search", "--difficulty", "abc"])


def test_sources(tmp_path, capsys):
    assert "local" in run(capsys, tmp_path / "x", "sources")[1].out


def test_env_data_dir(imported, capsys, monkeypatch):
    d, _ = imported
    monkeypatch.setenv("RUSTY_PIANO_SCORES_DIR", str(d))
    assert main(["scores", "list"]) == 0
    assert "2 score(s) in your library" in capsys.readouterr().out


def test_key_note_for_catalogue_only(tmp_path, capsys):
    d = tmp_path / "cat"
    with Library(d) as lib:
        lib.upsert_catalogue([{"id": "x:1", "source": "x", "title": "Cat Only", "license_conflict": 0}])
    out = run(capsys, d, "search", "--key", "A minor")[1].out
    assert "No scores found." in out
    assert "Note: key and time signature are only known" in out


def test_script_entry():
    data = tomllib.loads(Path(__file__).parents[1].joinpath("pyproject.toml").read_text())
    assert data["project"]["scripts"]["coach"] == "rusty_piano_coach.cli:main"


def test_import_named_non_musicxml(tmp_path, capsys):
    d = tmp_path / "lib"
    midi = tmp_path / "tune.mid"
    midi.write_bytes(b"MThd\x00\x00\x00\x06\x00\x00\x00\x01\x00\x60MTrk\x00\x00\x00\x04\x00\xff/\x00")
    code, cap = run(capsys, d, "import", str(midi))
    assert code == 0
    assert "skipped" in cap.out and "not a MusicXML file" in cap.out
    assert "Imported 0, skipped 1, already had 0." in cap.out
    assert not list((d / "files" / "local").glob("*"))
    assert "0 score(s) in your library" in run(capsys, d, "list")[1].out
