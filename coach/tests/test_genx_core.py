import xml.etree.ElementTree as ET
from types import SimpleNamespace

import pytest

from genx_check import count_notes
from rusty_piano_coach import compare
from rusty_piano_coach.library import gen, genx
from rusty_piano_coach.library.analyse import analyse_file
from rusty_piano_coach.library.genx import Gx, bars, collect, drill, walk, write
from rusty_piano_coach.library.gen import CATALOGUE, GenSource
from rusty_piano_coach.library.index import Library


def g(key="k-x", **kw):
    kw.setdefault("rh", "C4:w")
    return Gx(key, "R4 X", "R4", "reading", 60, **kw)


def root_of(ex):
    return ET.fromstring(write(ex).split("\n", 1)[1])


def notes_of(ex, staff="1"):
    return [n for n in root_of(ex).iter("note") if n.find("staff").text == staff]


def load(ex, tmp_path):
    p = tmp_path / "x.musicxml"
    p.write_text(write(ex), encoding="utf-8")
    return p, compare.load_score(p)


def test_bar_sums():
    with pytest.raises(ValueError, match="bad-bar"):
        write(Gx("bad-bar", "R4 x", "R4", "reading", 60, rh="C4 D4 E4"))
    with pytest.raises(ValueError):
        write(g(time="3/4"))
    write(g(time="2/4", rh="C4 D4"))


@pytest.mark.parametrize("tok", ["H4", "x", "r~"])
def test_unknown_tokens(tok):
    with pytest.raises(ValueError):
        write(g(rh=f"{tok} C4 C4 C4"))


def test_chord_tie_rest(tmp_path):
    ex = g(rh="C4+E4+G4:h C4:h~ | C4 D4 E4 r:q", lh="C3:w | G2:h. r:q", hands="both")
    p, sc = load(ex, tmp_path)
    assert count_notes(sc, "right") == 6
    assert count_notes(sc, "left") == 2
    text = write(ex)
    assert text.count("<chord />") + text.count("<chord/>") == 2
    assert 'type="start"' in text and 'type="stop"' in text
    assert root_of(ex).findall(".//tie[@type='start']") and root_of(ex).findall(".//tie[@type='stop']")


def test_dots_triplets(tmp_path):
    ex = g(rh="C4:3e D4:3e E4:3e C4:q. D4:e E4")
    p, sc = load(ex, tmp_path)
    qs = [n.q for n in compare.expected_notes(sc, hands="right")[0]]
    assert qs == pytest.approx([0, 1 / 3, 2 / 3, 1, 2.5, 3])
    ns = notes_of(ex)
    assert sum(n.find("time-modification") is not None for n in ns) == 3
    assert ns[0].find("notations/tuplet").get("type") == "start"
    assert ns[2].find("notations/tuplet").get("type") == "stop"
    assert ns[3].find("dot") is not None
    assert ns[3].find("duration").text == "18"


@pytest.mark.parametrize("rh", [
    "C4:e C4:3e C4:3e C4:3e C4:e C4 C4",
    "C4:3e C4:3e C4 C4 C4",
])
def test_triplet_errors(rh):
    with pytest.raises(ValueError):
        write(g(rh=rh))


def test_key_flat(tmp_path):
    ex = g(rh="F4 G4 A4 Bb4 | B4 C5 F4:h", fifths=-1)
    assert "<fifths>-1</fifths>" in write(ex)
    ns = notes_of(ex)
    assert ns[3].find("pitch/alter").text == "-1" and ns[3].find("accidental") is None
    assert ns[4].find("accidental").text == "natural"
    p, sc = load(ex, tmp_path)
    assert analyse_file(p).time_signature == "4/4"


def test_key_sharp():
    ns = notes_of(g(rh="F#4 F4 G4 A4", fifths=1))
    assert ns[0].find("accidental") is None
    assert ns[1].find("accidental").text == "natural"


def test_dynamics_pedal(tmp_path):
    ex = g(rh="p cresc C4 D4 E4 F4 | end f G4:w", lh="ped C3:w | pedup r", hands="both")
    root = root_of(ex)
    assert root.find(".//dynamics/p") is not None and root.find(".//dynamics/f") is not None
    assert {w.get("type") for w in root.iter("wedge")} == {"crescendo", "stop"}
    pedals = list(root.iter("pedal"))
    assert {p.get("type") for p in pedals} == {"start", "stop"}
    for d in root.iter("direction"):
        if d.find("direction-type/pedal") is not None:
            assert d.find("staff").text == "2"
    p, sc = load(ex, tmp_path)
    exp = compare.expected_notes(sc, hands="right")[0]
    assert exp[0].dynamic == "p" and exp[-1].dynamic == "f"


def test_articulation_slur_finger():
    ns = notes_of(g(rh="C4(@1 D4!@2 E4) F4"))
    assert ns[0].find("notations/slur").get("type") == "start"
    assert ns[0].find("notations/technical/fingering").text == "1"
    assert ns[1].find("notations/articulations/staccato") is not None
    assert ns[1].find("notations/technical/fingering").text == "2"
    assert ns[2].find("notations/slur").get("type") == "stop"


@pytest.mark.parametrize("rh", [
    "C4( D4 E4 F4",
    "end C4 D4 E4 F4",
    "pedup C4 D4 E4 F4",
    "ped C4 D4 E4 F4",
    "C4~ D4 E4 F4",
    "C4 D4 E4 F4~",
])
def test_more_errors(rh):
    with pytest.raises(ValueError):
        write(g(rh=rh))


def test_structure_errors():
    with pytest.raises(ValueError):
        write(g(rh="C4:w | C4:w", lh="C3:w", hands="both"))
    with pytest.raises(ValueError):
        write(g(rh="", lh=""))


def test_beams():
    ns = notes_of(g(rh="C4:e D4:e E4:e F4:e G4:h"))
    beams = [n.find("beam").text if n.find("beam") is not None else None for n in ns]
    assert beams == ["begin", "end", "begin", "end", None]
    ns = notes_of(g(rh="C4:3e D4:3e E4:3e C4 C4 C4"))
    beams = [n.find("beam").text if n.find("beam") is not None else None for n in ns]
    assert beams[:3] == ["begin", "continue", "end"]


def test_deterministic():
    ex = g(rh="p C4 D4 E4 F4")
    assert write(ex) == write(ex)


def test_walk_bars():
    a = walk(1, gen._UP5, 12)
    assert a == walk(1, gen._UP5, 12) and len(a) == 12 and set(a) <= set(gen._UP5)
    assert gen.melody(1, gen._UP5) == bars(a, 4) + " | C4:w"
    assert bars(list("abcdefgh"), 4) == "a b c d | e f g h"
    with pytest.raises(ValueError):
        bars(list("abc"), 2)


def test_drill():
    ex = Gx("r4-test", "R4 Test thing", "R4", "reading", 60, rh="C4:w", hands="right", mode="wait", goal="g")
    d = drill(ex)
    assert list(d) == ["id", "kind", "title", "score", "hands", "mode", "tempo", "loop", "bars", "goal"]
    assert d["id"] == "r4.test" and d["title"] == "Test thing" and d["score"] == "gen:r4-test"
    assert d["tempo"] == 100 and d["loop"] is False and d["bars"] is None
    assert drill(ex, hands="both")["hands"] == "both"
    p = Gx("piece-x", "X", "piece-x", "pieces", 80, rh="C4:w", hands="both", mode="live", goal="g")
    assert drill(p)["id"] == "piece.x" and drill(p)["title"] == "X"


def test_registry():
    assert all(n.startswith("track_") for n in genx.track_module_names())
    a, b = g("a-one"), g("b-two")
    m1 = SimpleNamespace(EXERCISES=[a])
    m2 = SimpleNamespace(EXERCISES=[b], PIECE_NODES=[{"id": "piece-x"}])
    assert collect([m1, m2]) == ([a, b], [{"id": "piece-x"}])
    with pytest.raises(ValueError):
        collect([m1, SimpleNamespace(EXERCISES=[a])])


def test_gen_hook(tmp_path, monkeypatch):
    assert gen.all_exercises()[:30] == gen.CATALOGUE
    assert gen.exercise_xml(CATALOGUE[0]) == gen.musicxml(CATALOGUE[0])
    waltz = Gx("r4-waltz", "R4 Waltz", "R4", "reading", 90, rh="C4:h. | E4 D4 C4", time="3/4",
               composer="Someone")
    monkeypatch.setattr(gen, "all_exercises", lambda: [CATALOGUE[0], waltz])
    lib = Library(tmp_path / "lib")
    assert GenSource().run_setup_step(lib, "exercises") == "Made 2 exercises"
    row = lib.get("gen:r4-waltz")
    assert row["time_signature"] == "3/4"
    assert row["composer"] == "Someone"
    assert row["tags"] == "exercise beginner r4 reading"
    assert "Makes 2 short" in GenSource().setup_steps(lib)[0].detail
    lib.close()


def beams(n):
    return [(b.get("number"), b.text) for b in n.findall("beam")]


def accs(ex, staff="1"):
    return [(a.text if (a := n.find("accidental")) is not None else None) for n in notes_of(ex, staff)]


def test_sixteenth_beams_and_hooks():
    ns = notes_of(g(rh="C4:s D4:s E4:s F4:s G4:q A4:h"))
    assert ns[0].find("type").text == "16th"
    assert beams(ns[0]) == [("1", "begin"), ("2", "begin")]
    assert beams(ns[1]) == [("1", "continue"), ("2", "continue")]
    assert beams(ns[3]) == [("1", "end"), ("2", "end")]
    ns = notes_of(g(rh="C4:e. D4:s G4:h. | C4:s D4:e. G4:h."))
    assert beams(ns[0]) == [("1", "begin")]
    assert beams(ns[1]) == [("1", "end"), ("2", "backward hook")]
    assert beams(ns[3]) == [("1", "begin"), ("2", "forward hook")]
    assert beams(notes_of(g(rh="C4:e D4:e E4:h."))[0]) == [("1", "begin")]
    with pytest.raises(ValueError):
        write(g(rh="C4:s. D4:q. E4:h"))


def test_six_eight(tmp_path):
    ex = g(time="6/8", rh="C4:e D4:e E4:e F4:e G4:e A4:e")
    r = root_of(ex)
    assert r.find(".//time/beats").text == "6" and r.find(".//time/beat-type").text == "8"
    assert r.find(".//metronome/beat-unit").text == "quarter"
    ns = notes_of(ex)
    assert [beams(n)[0][1] for n in ns] == ["begin", "continue", "end"] * 2
    p, _ = load(ex, tmp_path)
    assert analyse_file(p).time_signature == "6/8"
    with pytest.raises(ValueError):
        write(g(time="6/8", rh="C4:3e D4:3e E4:3e F4:h."))


def test_cut_time():
    r = root_of(g(time="2/2", rh="C4:w"))
    t = r.find(".//time")
    assert t.get("symbol") == "cut"
    assert t.find("beats").text == "2" and t.find("beat-type").text == "2"


def test_key_alters_and_accidentals():
    ex = g(fifths=2, rh="F#4:q C#4:q D4:q B3:q")
    assert accs(ex) == [None, None, None, None]
    assert [n.find("pitch/alter") is not None for n in notes_of(ex)] == [True, True, False, False]
    ex = g(fifths=-3, rh="Bb3:q Eb4:q Ab4:q D4:q")
    assert accs(ex) == [None] * 4
    assert [n.find("pitch/alter") is not None for n in notes_of(ex)] == [True, True, True, False]
    ex = g(fifths=7, rh="F#4:q C#4:q Fb4:q B4:q")
    assert accs(ex)[:2] == [None, None]
    assert accs(ex)[2] == "flat"
    ex = g(fifths=-7, rh="Bb3:q B3:q E4:q F4:q")
    assert accs(ex) == [None, "natural", "natural", "natural"]
    with pytest.raises(ValueError):
        write(g(fifths=8))


def test_accidental_bar_rule():
    assert accs(g(rh="F#4:h F#4:h")) == ["sharp", None]
    assert accs(g(rh="F#4:h F4:h")) == ["sharp", "natural"]
    assert accs(g(rh="F#4:h F4:h | F#4:h F5:h")) == ["sharp", "natural", "sharp", None]
    assert accs(g(rh="F#4:h~ F#4:h")) == ["sharp", None]
    assert accs(g(rh="F#4:h F#4:h~ | F#4:h F4:h")) == ["sharp", None, None, None]
    assert accs(g(rh="C4+C#4:w")) == [None, "sharp"]


def test_pickup():
    ex = g(rh="G4:q | C4:w", pickup=12)
    ns = notes_of(ex)
    assert ns[0].find("duration").text == "12"
    assert ET.tostring(root_of(ex).find("part/measure[1]/backup/duration"), encoding="unicode").strip() == "<duration>12</duration>"
    ex = g(rh="r:h G4:q | C4:w", pickup=36, time="4/4")
    assert write(ex)
    ex = g(rh="r | C4:w", pickup=12)
    assert notes_of(ex)[0].find("duration").text == "12"
    ex = g(rh="", lh="C3:q | C3:w", pickup=12, hands="left")
    n2 = notes_of(ex, "1")[0]
    assert n2.find("rest") is not None and n2.find("duration").text == "12"
    with pytest.raises(ValueError):
        write(g(rh="C4:w | C4:w", pickup=12))
    assert len(root_of(g(rh="G4:q | C4:w", pickup=12)).findall("part/measure")) == 2


def test_pickup_bare_rest_bar_one(tmp_path):
    from music21 import converter

    cases = [
        (g(rh="G4:q | C4:w", lh="", pickup=12, hands="right"), 12, "quarter", False),
        (g(rh="G4:q | C4:w", lh="r | C3:w", pickup=12), 12, "quarter", False),
        (g(rh="G4:q. | C4:w", lh="", pickup=18, hands="right"), 18, "quarter", True),
    ]
    for ex, dur, typ, dotted in cases:
        xml = write(ex)
        assert 'measure="yes"' not in xml.split("</measure>")[0]
        assert '<measure number="1" implicit="yes">' in xml
        rest = [n for n in notes_of(ex, "2") if n.find("rest") is not None][0]
        assert rest.find("duration").text == str(dur)
        assert rest.find("type").text == typ
        assert (rest.find("dot") is not None) == dotted
        score = converter.parseData(xml, format="musicxml")
        lens = [p.getElementsByClass("Measure")[0].duration.quarterLength for p in score.parts]
        assert lens[0] == lens[1] == dur / 12
    assert 'implicit' not in write(g(rh="C4:w | C4:w"))


def test_accent():
    n = notes_of(g(rh="C4:w>"))[0]
    arts = n.findall("notations/articulations")
    assert len(arts) == 1 and arts[0].find("accent") is not None
    n = notes_of(g(rh="C4:h>! D4:h"))[0]
    arts = n.findall("notations/articulations")
    assert len(arts) == 1
    assert arts[0].find("accent") is not None and arts[0].find("staccato") is not None


def test_ramp_drill():
    ex = g(drill_tempo=60, loop=True, ramp=True, target=100)
    d = drill(ex)
    assert d["tempo"] == 60 and d["loop"] is True and d["ramp"] is True and d["target"] == 100
    d = drill(g())
    assert d["tempo"] == 100 and d["loop"] is False and "ramp" not in d and "target" not in d
    for bad in (dict(drill_tempo=10), dict(drill_tempo=200), dict(ramp=True, target=100),
                dict(ramp=True, loop=True), dict(ramp=True, loop=True, target=301)):
        with pytest.raises(ValueError):
            write(g(**bad))


def test_combinations():
    ns = notes_of(g(rh="r:3e r:3e E4:3e G4:h."))
    assert all(n.find("time-modification") is not None for n in ns[:3])
    assert ns[0].find("rest") is not None
    ns = notes_of(g(rh="C4:3e~ C4:3e D4:3e G4:h."))
    assert ns[0].find("notations/tied").get("type") == "start"
    assert ns[1].find("tie").get("type") == "stop"
    ns = notes_of(g(rh="C4+E4:h( D4+F4:h)"))
    assert ns[0].find("notations/slur").get("type") == "start"
    assert ns[2].find("notations/slur").get("type") == "stop" and ns[3].find("notations/slur") is None
    assert ns[3].find("chord") is not None
    assert ns[1].find("notations/slur") is None
    ns = notes_of(g(rh="C4+E4:w@1"))
    assert ns[0].find("notations/technical/fingering").text == "1"
    assert ns[1].find("notations/technical") is None
    ex = g(rh="mf ped C4:q>  D4:q! f E4:q> pedchange F4:q pedup")
    r = root_of(ex)
    assert len(r.findall(".//direction")) >= 6
    assert len(r.findall(".//accent")) == 2 and len(r.findall(".//staccato")) == 1
