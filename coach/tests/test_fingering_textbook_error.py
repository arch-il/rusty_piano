import dataclasses

import pytest

from rusty_piano_coach.cli import main
from rusty_piano_coach.library import fingering, scale_fingering, scales
from rusty_piano_coach.library.index import Library


def _error_setup(tmp_path):
    lib = Library(tmp_path / "lib")
    scales.generate(lib, keys={"fs-minor-melodic-1oct-rh"})
    lib.close()
    path = tmp_path / "lib" / "files" / "scales" / "fs-minor-melodic-1oct-rh.musicxml"
    fingering.write_sidecar(path, source="pianoplayer", tool=fingering.pianoplayer_tool(), notes=[], error="old")
    return path


def test_cli_textbook_row_with_cached_error(tmp_path, capsys):
    path = _error_setup(tmp_path)
    assert main(["fingering", "--data-dir", str(tmp_path / "lib"), "--source", "scales"]) == 0
    out = capsys.readouterr().out
    assert "textbook (15 fingers)" in out
    assert "Fingering: 1 made, 0 cached, 0 failed" in out
    st = fingering.read_status(path)
    assert st["status"] == "ready"
    assert st["source"] == "textbook"
    assert st["notes"] == scale_fingering.scale_notes(scales.BY_KEY["fs-minor-melodic-1oct-rh"])
    assert main(["fingering", "--data-dir", str(tmp_path / "lib"), "--source", "scales"]) == 0
    assert "Fingering: 0 made, 1 cached, 0 failed" in capsys.readouterr().out


def test_cli_textbook_row_with_cached_error_by_id(tmp_path):
    path = _error_setup(tmp_path)
    assert main(["fingering", "--data-dir", str(tmp_path / "lib"), "--id", "scales:fs-minor-melodic-1oct-rh"]) == 0
    st = fingering.read_status(path)
    assert st["status"] == "ready"
    assert st["source"] == "textbook"


def test_unknown_kind_raises():
    orig = scales.BY_KEY["a-minor-harmonic-1oct-rh"]
    notes = scales.hand_notes(orig, "rh")
    with pytest.raises(ValueError, match="no fingering table"):
        scale_fingering.fingers(dataclasses.replace(orig, kind="minor-dorian"), "rh", notes)
