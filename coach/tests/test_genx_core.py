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
