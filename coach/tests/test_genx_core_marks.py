import xml.etree.ElementTree as ET

import pytest

from rusty_piano_coach import compare
from rusty_piano_coach.library.genx import Gx, write


def g(key="k-x", **kw):
    kw.setdefault("rh", "C4:w")
    return Gx(key, "R4 X", "R4", "reading", 60, **kw)


def root_of(ex):
    return ET.fromstring(write(ex).split("\n", 1)[1])


def load(ex, tmp_path):
    p = tmp_path / "x.musicxml"
    p.write_text(write(ex), encoding="utf-8")
    return p


def measure(ex, n=1):
    return root_of(ex).findall(".//measure")[n - 1]


def notes(m, voice=None, staff=None):
    out = []
    for n in m.findall("note"):
        if voice is not None and n.find("voice").text != str(voice):
            continue
        if staff is not None and n.find("staff").text != str(staff):
            continue
        out.append(n)
    return out


def test_rh2_voice3_stems(tmp_path):
    ex = g(rh="C5:h D5:h | C5:w", rh2="E4:h F4:h | E4:w", lh="C3:w | C3:w", hands="both")
    m = measure(ex)
    assert [n.find("stem").text for n in notes(m, 1)] == ["up", "up"]
    v3 = notes(m, 3)
    assert [n.find("stem").text for n in v3] == ["down", "down"]
    assert all(n.find("staff").text == "1" for n in v3)
    assert notes(m, 2)[0].find("stem") is None
    kids = [c.tag for c in v3[0]]
    assert kids.index("stem") < kids.index("staff") and kids.index("type") < kids.index("stem")
    tags = [c.tag for c in m if c.tag in ("note", "backup")]
    assert tags == ["note", "note", "backup", "note", "note", "backup", "note"]
    assert m.findall("backup")[0].find("duration").text == "48"
    ex1 = g(rh="C4:q D4 E4 F4", rh2="C3:w", hands="right")
    p = load(ex1, tmp_path)
    assert len(compare.expected_notes(compare.load_score(p), hands="right")[0]) == 5


def test_lh2_voice4():
    ex = g(rh="", lh="C3:h D3:h", lh2="E2:w", hands="left")
    m = measure(ex)
    v4 = notes(m, 4)
    assert len(v4) == 1 and v4[0].find("staff").text == "2"
    assert v4[0].find("stem").text == "down"
    assert [n.find("stem").text for n in notes(m, 2)] == ["up", "up"]
    with pytest.raises(ValueError):
        write(g(rh="", lh="C3:w", rh2="C4:w", hands="left"))
    with pytest.raises(ValueError):
        write(g(lh2="C3:w"))
    with pytest.raises(ValueError):
        write(g(rh="C4:w | C4:w", rh2="C4:w"))


def test_second_voice_pickup():
    ex = g(rh="C4:q | C4:w", rh2="E4:q | E4:w", pickup=12)
    m = measure(ex)
    assert [n.find("duration").text for n in notes(m, 3)] == ["12"]
    assert m.findall("backup")[0].find("duration").text == "12"


def clefs(m):
    return [(c.get("number"), c.findtext("sign"), c.findtext("line")) for c in m.findall("attributes/clef")]


def test_clef_change_xml():
    ex = g(rh="C4:w | C4:w", lh="C3:h treble C5:h | C3:h C5:h", hands="both")
    m1, m2 = measure(ex, 1), measure(ex, 2)
    assert clefs(m1) == [("1", "G", "2"), ("2", "F", "4"), ("2", "G", "2")]
    kids = list(m1)
    att = [a for a in m1.findall("attributes") if a.find("clef") is not None and a.find("divisions") is None][0]
    nxt = kids[kids.index(att) + 1]
    assert nxt.tag == "note" and nxt.find("pitch/step").text == "C" and nxt.find("pitch/octave").text == "5"
    assert nxt.find("staff").text == "2"
    assert clefs(m2) == []


def test_clef_change_back_and_same_is_skipped():
    ex = g(rh="C4:w | C4:w", lh="bass C3:h treble C5:h | treble C5:h bass C3:h", hands="both")
    assert clefs(measure(ex, 1)) == [("1", "G", "2"), ("2", "F", "4"), ("2", "G", "2")]
    assert clefs(measure(ex, 2)) == [("2", "F", "4")]


def test_clef_rh_voice():
    ex = g(rh="C4:h bass C3:h", lh="C3:w", hands="both")
    assert clefs(measure(ex)) == [("1", "G", "2"), ("2", "F", "4"), ("1", "F", "4")]


def test_clef_left_hand_in_music21(tmp_path):
    ex = g(rh="C4:w", lh="C3:h treble C5:h", hands="both")
    p = load(ex, tmp_path)
    left = compare.expected_notes(compare.load_score(p), hands="left")[0]
    right = compare.expected_notes(compare.load_score(p), hands="right")[0]
    assert len(left) == 2 and len(right) == 1
    assert sorted(n.pitch for n in left) == [48, 72]


def test_caret_raises():
    with pytest.raises(ValueError, match="treble"):
        write(g(rh="C4:w", lh="C3:q G3:q^ C3:q C3:q", hands="both"))


def test_marks_elements():
    ex = g(rh="C4:w | C4:w | C4:w | C4:w", marks="1:repeat-start 3:ending-1 3:repeat-end 4:ending-2")
    ms = root_of(ex).findall(".//measure")
    left = ms[0].find("barline[@location='left']")
    assert [c.tag for c in left] == ["bar-style", "repeat"]
    assert left.find("repeat").get("direction") == "forward"
    left3 = ms[2].find("barline[@location='left']")
    assert left3.find("ending").attrib == {"number": "1", "type": "start"}
    right3 = ms[2].find("barline[@location='right']")
    assert [c.tag for c in right3] == ["bar-style", "ending", "repeat"]
    assert right3.find("ending").attrib == {"number": "1", "type": "stop"}
    assert right3.find("repeat").get("direction") == "backward"
    left4 = ms[3].find("barline[@location='left']")
    assert left4.find("ending").attrib == {"number": "2", "type": "start"}
    right4 = ms[3].find("barline[@location='right']")
    assert right4.find("ending").attrib == {"number": "2", "type": "discontinue"}
    assert right4.find("bar-style").text == "light-heavy"
    assert len(ms[3].findall("barline")) == 2


def test_marks_directions():
    ex = g(rh=" | ".join(["C4:w"] * 5), marks="2:segno 2:fine 3:to-coda 4:dc-al-fine 4:ds-al-coda 5:coda")
    ms = root_of(ex).findall(".//measure")

    def sounds(m):
        return [(d.find("direction-type")[0].tag, d.find("direction-type")[0].text, dict(d.find("sound").attrib))
                for d in m.findall("direction") if d.find("sound").get("tempo") is None]

    assert sounds(ms[1]) == [("segno", None, {"segno": "segno"}), ("words", "Fine", {"fine": "yes"})]
    assert [c.tag for c in ms[1]][:2] == ["direction", "note"]
    assert sounds(ms[2]) == [("words", "To Coda", {"tocoda": "coda"})]
    assert sounds(ms[3]) == [("words", "D.C. al Fine", {"dacapo": "yes"}),
                             ("words", "D.S. al Coda", {"dalsegno": "segno"})]
    assert sounds(ms[4]) == [("coda", None, {"coda": "coda"})]
    last = ms[4].findall("barline")
    assert len(last) == 1 and last[0].get("location") == "right"
    assert [c.tag for c in ms[4]][-1] == "barline"


def test_marks_merge_last_bar_barline():
    ex = g(rh="C4:w | C4:w", marks="2:repeat-end")
    r = measure(ex, 2).findall("barline")
    assert len(r) == 1 and [c.tag for c in r[0]] == ["bar-style", "repeat"]


def test_marks_errors():
    with pytest.raises(ValueError):
        write(g(marks="1:bogus"))
    with pytest.raises(ValueError):
        write(g(marks="2:fine"))
    with pytest.raises(ValueError):
        write(g(marks="0:fine"))


def test_harmony_root_alter_bass():
    ex = g(rh="C4:h D4:h", symbols="1:F#m7/Bb 1.3:Bb")
    m = measure(ex)
    kids = list(m)
    h = m.findall("harmony")
    assert len(h) == 2
    assert kids[kids.index(h[0]) + 1].tag == "note"
    assert h[0].find("root/root-step").text == "F"
    assert h[0].find("root/root-alter").text == "1"
    assert h[0].find("kind").text == "minor-seventh"
    assert h[0].find("kind").get("text") == "m7"
    assert h[0].find("bass/bass-step").text == "B"
    assert h[0].find("bass/bass-alter").text == "-1"
    assert h[1].find("root/root-alter").text == "-1"
    assert h[1].find("kind").text == "major"
    assert h[1].find("bass") is None
    assert kids[kids.index(h[1]) + 1].find("pitch/step").text == "D"


@pytest.mark.parametrize("sym,kind", [("C", "major"), ("Cm", "minor"), ("C7", "dominant"), ("Cmaj7", "major-seventh"),
                                      ("Cdim", "diminished"), ("Caug", "augmented"), ("Cm7b5", "half-diminished"),
                                      ("Cdim7", "diminished-seventh")])
def test_harmony_kinds(sym, kind):
    assert measure(g(symbols=f"1:{sym}")).find("harmony/kind").text == kind


def test_harmony_errors():
    with pytest.raises(ValueError):
        write(g(rh="C4:h D4:h", symbols="1.2:C"))
    with pytest.raises(ValueError):
        write(g(symbols="1:H"))
    with pytest.raises(ValueError):
        write(g(symbols="2:C"))


def test_harmony_lh_only_before_chord():
    ex = g(rh="", lh="C3+E3+G3:w", hands="left", symbols="1:C")
    m = measure(ex)
    kids = list(m)
    h = m.find("harmony")
    nxt = kids[kids.index(h) + 1]
    assert nxt.tag == "note" and nxt.find("chord") is None and nxt.find("staff").text == "2"
    assert len(m.findall("harmony")) == 1


def test_symbols_do_not_change_expected_notes(tmp_path):
    a = g(rh="C4:h E4:h | G4:w", lh="C3:w | G2:w", hands="both")
    b = g(rh="C4:h E4:h | G4:w", lh="C3:w | G2:w", hands="both", symbols="1:C 1.3:Am7 2:G7/B")
    pa = tmp_path / "a.musicxml"
    pb = tmp_path / "b.musicxml"
    pa.write_text(write(a), encoding="utf-8")
    pb.write_text(write(b), encoding="utf-8")
    ea = compare.expected_notes(compare.load_score(pa))
    eb = compare.expected_notes(compare.load_score(pb))
    assert ea[0] == eb[0] and ea[1] == eb[1]


def test_pickup_must_be_single_duration():
    for bad in (30, 15, 5):
        with pytest.raises(ValueError):
            write(g(rh="C4:w", pickup=bad))


def _order(tmp_path, nbars, marks):
    ex = g(rh=" | ".join(["C4:w"] * nbars), marks=marks)
    return compare.expected_notes(compare.load_score(load(ex, tmp_path)))[1]


def test_order_repeat(tmp_path):
    assert _order(tmp_path, 4, "1:repeat-start 4:repeat-end") == [1, 2, 3, 4, 1, 2, 3, 4]


def test_order_endings(tmp_path):
    assert _order(tmp_path, 4, "1:repeat-start 3:ending-1 3:repeat-end 4:ending-2") == [1, 2, 3, 1, 2, 4]


def test_order_dc(tmp_path):
    assert _order(tmp_path, 4, "2:fine 4:dc-al-fine") == [1, 2, 3, 4, 1, 2]


def test_order_ds(tmp_path):
    assert _order(tmp_path, 5, "2:segno 3:to-coda 4:ds-al-coda 5:coda") == [1, 2, 3, 4, 2, 3, 5]
