import importlib.util
import json
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from rusty_piano_coach.library import fingering
from rusty_piano_coach.library.fingering import (
    normalise_finger,
    read_score_root,
    read_status,
    score_notes,
    sidecar_path,
    write_sidecar,
    written_fingering,
)
from rusty_piano_coach.library.genx import track_technique

FIXTURES = Path(__file__).resolve().parents[1] / "web" / "tests" / "fixtures"
MARKS = FIXTURES / "fingering_marks.musicxml"
EXPECTED = FIXTURES / "fingering_marks.expected.json"


def _expected_notes():
    return json.loads(EXPECTED.read_text(encoding="utf-8"))["notes"]


def _note(step, octave, duration, staff=None, extra=""):
    st = f"<staff>{staff}</staff>" if staff else ""
    return (
        f"<note><pitch><step>{step}</step><octave>{octave}</octave></pitch>"
        f"<duration>{duration}</duration>{st}{extra}</note>"
    )


def _score(parts):
    body = "".join(parts)
    return ET.fromstring(f'<score-partwise version="3.1">{body}</score-partwise>')


def test_written_fingering_matches_expected():
    assert written_fingering(read_score_root(MARKS)) == _expected_notes()


def test_score_notes_keys():
    notes = score_notes(read_score_root(MARKS))
    assert len(notes) == 12
    assert not [n for n in notes if n["p"] == 77]
    by_key = {(n["m"], n["q"], n["s"], n["p"]): n for n in notes}
    assert by_key[(1, 2.0, 1, 55)]["f"] is None
    assert by_key[(2, 0, 0, 76)]["f"] is None


def test_mxl(make_mxl, tmp_path):
    mxl = make_mxl(MARKS, tmp_path / "x.mxl")
    assert written_fingering(read_score_root(mxl)) == _expected_notes()


def test_two_parts_staff_offsets():
    root = _score(
        [
            '<part id="P1"><measure number="1"><attributes><divisions>1</divisions><staves>2</staves></attributes>'
            + _note("C", 4, 4, staff=2)
            + "</measure></part>",
            '<part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes>'
            + _note("D", 4, 4)
            + "</measure></part>",
        ]
    )
    by_p = {n["p"]: n for n in score_notes(root)}
    assert by_p[62]["s"] == 2
    assert by_p[60]["s"] == 1


def test_forward_and_divisions():
    root = _score(
        [
            '<part id="P1"><measure number="1"><attributes><divisions>4</divisions></attributes>'
            "<forward><duration>2</duration></forward>"
            + _note("C", 4, 4)
            + "</measure>"
            '<measure number="2"><attributes><divisions>1</divisions></attributes>'
            + _note("D", 4, 2)
            + _note("E", 4, 1)
            + "</measure></part>"
        ]
    )
    by_p = {n["p"]: n for n in score_notes(root)}
    assert by_p[60]["q"] == 0.5
    assert by_p[64]["q"] == 2.0


def test_normalise_finger():
    assert normalise_finger("①") == "1"
    assert normalise_finger(" 3 ") == "3"
    assert normalise_finger("") is None
    assert normalise_finger(None) is None
    assert normalise_finger("2-1") == "2-1"


def test_gen_ground_truth():
    ex = next(e for e in track_technique.EXERCISES if e.key == "k2-legato-rh")
    root = ET.fromstring(ex.musicxml().encode("utf-8"))
    notes = written_fingering(root)
    assert len(notes) == len(root.findall(".//fingering")) == 9
    f4 = [n for n in notes if n["p"] == 65]
    assert len(f4) == 2
    assert all(n["f"] == "4" for n in f4)
    assert [n["f"] for n in notes if n["p"] == 67] == ["5"]


def test_sidecar_cycle(tmp_path):
    score = tmp_path / "s.musicxml"
    shutil.copyfile(MARKS, score)
    assert read_status(score)["status"] == "none"
    notes = [{"m": 0, "q": 0.0, "s": 0, "p": 67, "f": "5"}]
    write_sidecar(score, source="pianoplayer", tool="t", notes=notes)
    st = read_status(score)
    assert st["status"] == "ready"
    assert st["notes"] == notes
    assert st["source"] == "pianoplayer"
    side = sidecar_path(score)
    before = side.stat().st_mtime_ns
    write_sidecar(score, source="pianoplayer", tool="t", notes=notes)
    assert side.stat().st_mtime_ns == before
    with open(score, "a", encoding="utf-8", newline="") as f:
        f.write("\n<!-- changed -->\n")
    assert read_status(score)["status"] == "none"
    write_sidecar(score, source="pianoplayer", tool="t", notes=[], error="boom")
    st = read_status(score)
    assert st["status"] == "error"
    assert st["error"] == "boom"
    assert st["notes"] == []
    side.write_text("{not json", encoding="utf-8")
    assert read_status(score)["status"] == "none"
    obj = {"version": 0, "score_sha256": fingering.file_sha256(score), "source": "x", "tool": "t",
           "error": None, "notes": []}
    side.write_text(json.dumps(obj), encoding="utf-8")
    assert read_status(score)["status"] == "none"


class _Runner:
    def __init__(self, exc=None):
        self.calls = 0
        self.exc = exc

    def __call__(self, path):
        self.calls += 1
        if self.exc:
            raise self.exc
        return [{"m": 0, "q": 0.0, "s": 0, "p": 67, "f": "5"}]


def test_generate_with_runner(tmp_path):
    score = tmp_path / "s.musicxml"
    shutil.copyfile(MARKS, score)
    r = _Runner()
    st = fingering.generate(score, runner=r)
    assert st["status"] == "ready"
    assert st["source"] == "pianoplayer"
    fingering.generate(score, runner=r)
    assert r.calls == 1
    fingering.generate(score, runner=r, force=True)
    assert r.calls == 2

    other = tmp_path / "o.musicxml"
    shutil.copyfile(MARKS, other)
    bad = _Runner(RuntimeError("bad"))
    st = fingering.generate(other, runner=bad)
    assert st["status"] == "error"
    assert st["error"] == "bad"
    fingering.generate(other, runner=bad)
    assert bad.calls == 1


def test_generate_uses_module_runner(tmp_path, monkeypatch):
    score = tmp_path / "s.musicxml"
    shutil.copyfile(MARKS, score)
    r = _Runner()
    monkeypatch.setattr(fingering, "run_pianoplayer", r)
    assert fingering.generate(score)["status"] == "ready"
    assert r.calls == 1


def test_three_staff_refused(tmp_path):
    score = tmp_path / "three.musicxml"
    score.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<score-partwise version="3.1">'
        '<part id="P1"><measure number="1"><attributes><divisions>1</divisions><staves>3</staves></attributes>'
        + _note("C", 4, 4, staff=3)
        + "</measure></part></score-partwise>",
        encoding="utf-8",
    )
    r = _Runner()
    assert fingering.generate(score, runner=fingering.run_pianoplayer)["status"] == "error"
    assert r.calls == 0
    assert "1-2 staff" in read_status(score)["error"]


@pytest.mark.skipif(importlib.util.find_spec("pianoplayer") is None, reason="pianoplayer not installed")
def test_real_pianoplayer_run():
    path = Path(__file__).parent / "fixtures" / "simple_c_major.musicxml"
    notes = fingering.run_pianoplayer(path, timeout_s=90)
    assert notes
    assert all(n["f"] in {"1", "2", "3", "4", "5"} for n in notes)
    keys = {(n["m"], n["q"], n["s"], n["p"]) for n in score_notes(read_score_root(path))}
    assert all((n["m"], n["q"], n["s"], n["p"]) in keys for n in notes)
