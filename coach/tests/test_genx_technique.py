import hashlib
import xml.etree.ElementTree as ET

import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach import compare
from rusty_piano_coach.library.genx import core, track_technique

NODES = ["K2", "K3", "K4", "K5", "K6", "K8", "K9", "K10", "K11"]
PINS = {
    "k2-legato-rh": "4584936b0f49dc17", "k2-legato-lh": "416f67a5a22ee4b0",
    "k2-two-note-slurs": "579e47001e1d5556", "k2-phrases": "d0646b7925ffed7f",
    "k2-halves-lh": "7169fd05332ea04b", "k3-staccato-rh": "947e97ead1ab8fa3",
    "k3-staccato-lh": "2d752558551fbdb7",
}
KEYS = [
    "k2-legato-rh", "k2-legato-lh", "k2-two-note-slurs", "k2-phrases", "k2-halves-lh",
    "k3-staccato-rh", "k3-staccato-lh", "k3-repeated", "k3-legato-staccato", "k3-staccato-eighths",
    "k4-c-to-g", "k4-octave-rh", "k4-octave-lh", "k4-c-to-a", "k4-no-rest",
    "k5-c-chord-rh", "k5-c-chord-lh", "k5-c-g7-rh", "k5-c-f-g-lh", "k5-chords-quarters",
    "k6-broken-c-rh", "k6-broken-lh", "k6-alberti-lh", "k6-broken-c-f-g",
    "k8-hold-thumb-rh", "k8-hold-five-rh", "k8-hold-lh", "k8-two-voices-rh",
    "k9-thirds-rh", "k9-thirds-lh", "k9-sixths-rh", "k9-slurred-thirds",
    "k10-octaves-rh", "k10-octaves-lh", "k10-leaps-lh", "k10-crossing",
    "k11-hanon-rh", "k11-hanon-lh", "k11-thirds-rh", "k11-thirds-lh",
]
SLOW = {"k3-staccato-eighths", "k6-alberti-lh", "k6-broken-c-f-g"}


@pytest.fixture(scope="module")
def loaded(tmp_path_factory):
    return check_exercises(track_technique.EXERCISES, tmp_path_factory.mktemp("technique"),
                           track="technique", nodes=NODES)


def root_of(ex):
    return ET.fromstring(ex.musicxml().split("\n", 1)[1])


def by_key(key):
    return next(e for e in track_technique.EXERCISES if e.key == key)


def test_house_rules(loaded):
    assert len(loaded) == 40


def test_counts_and_keys():
    counts = {n: 0 for n in NODES}
    for e in track_technique.EXERCISES:
        counts[e.node] += 1
    assert counts == {"K2": 5, "K3": 5, "K4": 5, "K5": 5, "K6": 4,
                      "K8": 4, "K9": 4, "K10": 4, "K11": 4}
    assert [e.key for e in track_technique.EXERCISES] == KEYS


def test_features():
    for e in track_technique.EXERCISES:
        root = root_of(e)
        slurs = [s.get("type") for s in root.iter("slur")]
        if e.node == "K2":
            assert "start" in slurs and "stop" in slurs, e.key
        if e.node == "K3":
            assert any(True for _ in root.iter("staccato")), e.key
        if e.node == "K5":
            assert any(True for _ in root.iter("chord")), e.key


def test_key_signatures():
    for e in track_technique.EXERCISES:
        fifths = [f.text for f in root_of(e).iter("fifths")]
        assert fifths == ["0"], e.key


def test_chord_count(loaded):
    assert count_notes(loaded["k5-c-chord-rh"], "right") == 21


def test_meta():
    for e in track_technique.EXERCISES:
        assert e.mode == "live", e.key
        if e.node == "K11":
            expected = 80
        elif e.key in SLOW or e.node in ("K8", "K9", "K10"):
            expected = 60
        else:
            expected = 72
        assert e.bpm == expected, e.key


def test_pins():
    for key, pin in PINS.items():
        assert hashlib.sha256(by_key(key).musicxml().encode()).hexdigest()[:16] == pin, key


def test_k11_drills():
    for e in track_technique.EXERCISES:
        if e.node == "K11":
            d = core.drill(e)
            assert d["loop"] is True and d["ramp"] is True, e.key
            assert d["target"] == 130 and d["tempo"] == 70, e.key


def test_k8_voices():
    for key in ("k8-hold-thumb-rh", "k8-hold-five-rh", "k8-hold-lh", "k8-two-voices-rh"):
        text = by_key(key).musicxml()
        assert ("<voice>4</voice>" if key == "k8-hold-lh" else "<voice>3</voice>") in text, key
        assert "<stem>" in text, key


def test_k10_crossing(tmp_path):
    ex = by_key("k10-crossing")
    root = root_of(ex)
    lh = [n for n in root.iter("note") if n.findtext("voice") == "2"]
    assert len(lh) == 8
    assert all(n.findtext("staff") == "2" for n in lh)
    assert not any(n.findtext("staff") == "1" and n.findtext("voice") == "2" for n in root.iter("note"))
    signs = [(c.get("number"), c.findtext("sign")) for c in root.iter("clef")]
    assert signs.count(("2", "G")) == 4 and signs.count(("2", "F")) == 4
    p = tmp_path / "k10.musicxml"
    p.write_text(ex.musicxml(), encoding="utf-8")
    left = compare.expected_notes(compare.load_score(p), hands="left")[0]
    assert len(left) == 8
