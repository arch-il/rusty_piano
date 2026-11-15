import xml.etree.ElementTree as ET

import pytest

from genx_check import check_exercises
from rusty_piano_coach import compare
from rusty_piano_coach.library.genx.track_expression import EXERCISES

EXPR = [e for e in EXERCISES if e.track == "expression"]
PEDAL = [e for e in EXERCISES if e.track == "pedal"]

EXPR_KEYS = [
    "d1-loud-soft-rh", "d1-echo-rh", "d1-soft-loud-lh", "d1-echo-lh", "d1-three-levels",
    "d2-held-bass", "d2-chords", "d2-lh-tune", "d2-waltz", "d2-alberti",
    "d3-cresc-rh", "d3-cresc-lh", "d3-one-phrase", "d3-both-hands", "d3-phrase-34",
]
PEDAL_KEYS = [
    "p1-whole-chords", "p1-half-chords", "p1-tune-over-fifths", "p1-broken-chords", "p1-rh-chords",
]


@pytest.fixture(scope="module")
def expr_loaded(tmp_path_factory):
    return check_exercises(EXPR, tmp_path_factory.mktemp("expr"), track="expression", nodes=["D1", "D2", "D3"])


@pytest.fixture(scope="module")
def pedal_loaded(tmp_path_factory):
    return check_exercises(PEDAL, tmp_path_factory.mktemp("pedal"), track="pedal", nodes=["P1"])


def xml(ex):
    return ET.fromstring(ex.musicxml().split("\n", 1)[1])


def by_key(key):
    return next(e for e in EXERCISES if e.key == key)


def test_house_rules(expr_loaded, pedal_loaded):
    assert len(expr_loaded) == 15
    assert len(pedal_loaded) == 5
    assert len(EXERCISES) == 20
    assert [e.key for e in EXPR] == EXPR_KEYS
    assert [e.key for e in PEDAL] == PEDAL_KEYS


def test_dynamics():
    for ex in EXPR:
        assert xml(ex).findall(".//dynamics"), ex.key


def test_hairpins():
    for ex in EXPR:
        if ex.node != "D3":
            continue
        types = {w.get("type") for w in xml(ex).iter("wedge")}
        assert types & {"crescendo", "diminuendo"}, ex.key
        assert "stop" in types, ex.key


def test_pedal():
    for ex in PEDAL:
        root = xml(ex)
        types = [p.get("type") for p in root.iter("pedal")]
        assert types[0] == "start", ex.key
        assert types[-1] == "stop", ex.key
        assert "change" in types, ex.key
        staffs = set()
        for d in root.iter("direction"):
            if d.find("direction-type/pedal") is not None:
                staffs.add(d.find("staff").text)
        expected = {"1"} if ex.key == "p1-rh-chords" else {"2"}
        assert staffs == expected, ex.key


def test_d2_staff_dynamics():
    root = xml(by_key("d2-held-bass"))
    marks = {}
    for d in root.iter("direction"):
        dyn = d.find("direction-type/dynamics")
        if dyn is not None:
            marks[d.find("staff").text] = list(dyn)[0].tag
    assert marks == {"1": "f", "2": "p"}


def test_d1_follower_dynamic(expr_loaded):
    sc = expr_loaded["d1-loud-soft-rh"]
    notes = compare.expected_notes(sc, hands="right")[0]
    assert notes[0].dynamic == "f"
    assert [n for n in notes if n.q == 8.0][0].dynamic == "p"


def test_meta():
    for ex in EXERCISES:
        assert ex.mode == "live", ex.key
    for ex in EXPR:
        assert ex.bpm == 72, ex.key
    for ex in PEDAL:
        assert ex.bpm == 60, ex.key
    assert {e.key for e in EXERCISES if e.time == "3/4"} == {"d2-waltz", "d3-phrase-34"}
