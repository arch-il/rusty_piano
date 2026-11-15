import argparse
import io
import sys

import pytest

from fake_pdmx import FAKE_IDS, build
from rusty_piano_coach.cli import main
from rusty_piano_coach.library.cli import add_scores_parser

COMMANDS = ["sources", "sync", "fetch-archive", "download", "delete", "import", "search", "list", "show"]


def run(capsys, d, *args):
    code = main(["scores", "--data-dir", str(d), *args])
    return code, capsys.readouterr()


@pytest.fixture
def imported(tmp_path, fixtures_dir, capsys):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(fixtures_dir)]) == 0
    capsys.readouterr()
    return d


@pytest.mark.parametrize("args", [["search", "--limit", "0"], ["search", "--limit", "-1"], ["list", "--limit", "0"]])
def test_limit_must_be_positive(tmp_path, capsys, args):
    with pytest.raises(SystemExit) as e:
        main(["scores", "--data-dir", str(tmp_path / "lib"), *args])
    assert e.value.code == 2
    assert "1 or more" in capsys.readouterr().err


def test_data_dir_after_subcommand(tmp_path, capsys, fixtures_dir):
    d = tmp_path / "lib"
    assert main(["scores", "import", str(fixtures_dir), "--data-dir", str(d)]) == 0
    capsys.readouterr()
    assert main(["scores", "list", "--data-dir", str(d)]) == 0
    assert "Simple C Major" in capsys.readouterr().out
    assert not (tmp_path / "default_scores" / "library.sqlite").exists()


def test_unknown_source(imported, capsys):
    code, cap = run(capsys, imported, "search", "x", "--source", "nope")
    assert code == 1
    assert "unknown source 'nope'" in cap.err


def test_punctuation_only(imported, capsys):
    code, cap = run(capsys, imported, "search", "!!!")
    assert code == 0
    assert "No scores found." in cap.out
    assert "no letters or digits" in cap.out


def test_empty_index_hints(tmp_path, capsys):
    d = tmp_path / "new"
    assert "coach scores sync pdmx" in run(capsys, d, "search", "bach")[1].out
    assert "coach scores sync pdmx" in run(capsys, tmp_path / "new2", "list")[1].out


def test_list_no_downloads_hint(tmp_path, capsys):
    d = tmp_path / "cat"
    build(d)
    assert "coach scores download" in run(capsys, d, "list")[1].out


@pytest.mark.parametrize("name", COMMANDS)
def test_subcommand_help(name, capsys):
    with pytest.raises(SystemExit) as e:
        main(["scores", name, "--help"])
    assert e.value.code == 0
    capsys.readouterr()


def test_every_option_has_help():
    p = argparse.ArgumentParser()
    scores = add_scores_parser(p.add_subparsers())
    action = next(a for a in scores._actions if isinstance(a, argparse._SubParsersAction))
    assert action._choices_actions
    for ca in action._choices_actions:
        assert ca.help
    for name, sub in action.choices.items():
        for a in sub._actions:
            if isinstance(a, argparse._HelpAction):
                continue
            assert a.help, f"{name}: {a.dest}"


def test_download_exit_code(tmp_path, capsys):
    d = tmp_path / "cat"
    build(d)
    a, e = FAKE_IDS["hymn"], FAKE_IDS["missing"]
    code, cap = run(capsys, d, "download", a, e)
    assert code == 1
    assert "downloaded #" in cap.out
    assert f"not found in archive: {e}" in cap.out
    assert "not downloaded" in cap.err and "Missing Test" in cap.err
    assert run(capsys, d, "download", a)[0] == 0


def test_line_buffering(tmp_path, monkeypatch):
    class Fake(io.StringIO):
        def reconfigure(self, **kw):
            self.kw = kw

    out, err = Fake(), Fake()
    monkeypatch.setattr(sys, "stdout", out)
    monkeypatch.setattr(sys, "stderr", err)
    assert main(["scores", "--data-dir", str(tmp_path / "lib"), "sources"]) == 0
    assert out.kw["line_buffering"] is True
    assert err.kw["line_buffering"] is True
