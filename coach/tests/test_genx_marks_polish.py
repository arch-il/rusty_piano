import xml.etree.ElementTree as ET

import music21
import pytest

from rusty_piano_coach.compare import load_score
from rusty_piano_coach.library import genx
from rusty_piano_coach.library.fingering import score_notes
from rusty_piano_coach.library.genx import Gx, write

by_key = {e.key: e for e in genx.all_exercises()}


def _root(ex):
    return ET.fromstring(write(ex).encode("utf-8"))


def _m1(ex):
    return _root(ex).find("part/measure")


def _sounds(m1):
    return [s.get("tempo") for s in m1.findall("direction/sound")]


def test_six_eight_mark():
    m1 = _m1(by_key["t9-dotted-quarters"])
    mets = m1.findall("direction/direction-type/metronome")
    assert len(mets) == 2
    a, b = mets
    assert a.findtext("beat-unit") == "quarter"
    assert a.find("beat-unit-dot") is not None
    assert a.findtext("per-minute") == "60"
    assert a.get("print-object") is None
    assert b.get("print-object") == "no"
    assert b.findtext("beat-unit") == "quarter"
    assert b.findtext("per-minute") == "90"
    assert b.find("beat-unit-dot") is None
    assert _sounds(m1) == ["90"]


def test_cut_time_mark():
    m1 = _m1(by_key["t10-cut-time"])
    a, b = m1.findall("direction/direction-type/metronome")
    assert a.findtext("beat-unit") == "half"
    assert a.findtext("per-minute") == "50"
    assert a.get("print-object") is None
    assert b.get("print-object") == "no"
    assert b.findtext("beat-unit") == "quarter"
    assert b.findtext("per-minute") == "100"
    assert _sounds(m1) == ["100"]


@pytest.mark.parametrize(
    "key", ["t9-dotted-quarters", "t9-mixed", "t10-cut-time", "t10-cut-time-both", "piece-row-your-boat"]
)
def test_quarter_bpm_kept(key, tmp_path):
    ex = by_key[key]
    path = tmp_path / (key + ".musicxml")
    path.write_text(write(ex), encoding="utf-8")
    assert load_score(path).score_bpm == ex.bpm
    marks = [
        el for el in music21.converter.parse(str(path)).recurse() if isinstance(el, music21.tempo.MetronomeMark)
    ]
    assert marks
    for mm in marks:
        assert mm.getQuarterBPM() == ex.bpm


@pytest.mark.parametrize("key", ["t8-sixteenths-rh", "t10-two-four-rh"])
def test_other_times_unchanged(key):
    ex = by_key[key]
    m1 = _m1(ex)
    mets = m1.findall("direction/direction-type/metronome")
    assert len(mets) == 1
    assert mets[0].findtext("beat-unit") == "quarter"
    assert mets[0].findtext("per-minute") == str(ex.bpm)
    assert mets[0].get("print-object") is None
    assert _sounds(m1) == [str(ex.bpm)]


def test_bpm_must_fit():
    with pytest.raises(ValueError, match="multiple of 3"):
        write(Gx("k-x", "T", "T9", "rhythm", 100, rh="C4:h.", time="6/8"))
    with pytest.raises(ValueError, match="even"):
        write(Gx("k-y", "T", "T10", "rhythm", 75, rh="C4:w", time="2/2"))


def test_k8_every_note_fingered():
    cases = (("k8-hold-thumb-rh", 60, "1"), ("k8-hold-five-rh", 67, "5"), ("k8-hold-lh", 48, "5"))
    for key, midi, finger in cases:
        notes = score_notes(_root(by_key[key]))
        assert all(n["f"] is not None for n in notes)
        held = [n for n in notes if n["p"] == midi]
        assert len(held) == 4
        assert all(n["f"] == finger for n in held)
        if key == "k8-hold-thumb-rh":
            for p, f in {62: "2", 64: "3", 65: "4", 67: "5"}.items():
                got = [n for n in notes if n["p"] == p]
                assert got and all(n["f"] == f for n in got)


def test_two_voice_fingering_placement():
    root = _root(by_key["k8-hold-thumb-rh"])
    seen = set()
    for note in root.iter("note"):
        fing = note.find("notations/technical/fingering")
        stem = note.findtext("stem")
        if fing is None or stem not in ("up", "down"):
            continue
        assert fing.get("placement") == ("above" if stem == "up" else "below")
        seen.add(stem)
    assert seen == {"up", "down"}
    one = _root(Gx("k-z", "T", "K1", "technique", 60, rh="C4@1 D4@2 E4@3 F4@4 | G4:w@5"))
    fings = list(one.iter("fingering"))
    assert fings
    assert all("placement" not in f.attrib for f in fings)
