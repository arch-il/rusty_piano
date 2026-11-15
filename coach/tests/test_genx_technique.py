import xml.etree.ElementTree as ET

import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach.library.genx import track_technique

NODES = ["K2", "K3", "K4", "K5", "K6", "K7"]
KEYS = [
    "k2-legato-rh", "k2-legato-lh", "k2-two-note-slurs", "k2-phrases", "k2-halves-lh",
    "k3-staccato-rh", "k3-staccato-lh", "k3-repeated", "k3-legato-staccato", "k3-staccato-eighths",
    "k4-c-rh", "k4-c-lh", "k4-g-rh", "k4-g-lh", "k4-f-rh", "k4-f-lh",
    "k5-c-to-g", "k5-octave-rh", "k5-octave-lh", "k5-c-to-a", "k5-no-rest",
    "k6-c-chord-rh", "k6-c-chord-lh", "k6-c-g7-rh", "k6-c-f-g-lh", "k6-chords-quarters",
    "k7-broken-c-rh", "k7-broken-lh", "k7-alberti-lh", "k7-arpeggio-rh", "k7-broken-c-f-g",
]
SLOW = {
    "k4-c-rh", "k4-c-lh", "k4-g-rh", "k4-g-lh", "k4-f-rh", "k4-f-lh",
    "k3-staccato-eighths", "k7-alberti-lh", "k7-broken-c-f-g",
}


@pytest.fixture(scope="module")
def loaded(tmp_path_factory):
    return check_exercises(track_technique.EXERCISES, tmp_path_factory.mktemp("technique"),
                           track="technique", nodes=NODES)


def root_of(ex):
    return ET.fromstring(ex.musicxml().split("\n", 1)[1])


def by_key(key):
    return next(e for e in track_technique.EXERCISES if e.key == key)


def test_house_rules(loaded):
    assert len(loaded) == 31


def test_counts_and_keys():
    counts = {n: 0 for n in NODES}
    for e in track_technique.EXERCISES:
        counts[e.node] += 1
    assert counts == {"K2": 5, "K3": 5, "K4": 6, "K5": 5, "K6": 5, "K7": 5}
    assert [e.key for e in track_technique.EXERCISES] == KEYS


def test_features():
    for e in track_technique.EXERCISES:
        root = root_of(e)
        slurs = [s.get("type") for s in root.iter("slur")]
        if e.node == "K2":
            assert "start" in slurs and "stop" in slurs, e.key
        if e.node == "K3":
            assert any(True for _ in root.iter("staccato")), e.key
        if e.node == "K4":
            pitched = [n for n in root.iter("note") if n.find("pitch") is not None]
            assert len(list(root.iter("fingering"))) == len(pitched), e.key
        if e.node == "K6":
            assert any(True for _ in root.iter("chord")), e.key


def test_scale_keys():
    for e in track_technique.EXERCISES:
        fifths = [f.text for f in root_of(e).iter("fifths")]
        text = e.rh + e.lh
        if e.key in ("k4-g-rh", "k4-g-lh"):
            assert fifths == ["1"] and "F#" in text, e.key
        elif e.key in ("k4-f-rh", "k4-f-lh"):
            assert fifths == ["-1"] and "Bb" in text, e.key
        else:
            assert fifths == ["0"], e.key


def test_chord_count(loaded):
    assert count_notes(loaded["k6-c-chord-rh"], "right") == 21


def test_meta():
    for e in track_technique.EXERCISES:
        assert e.mode == "live", e.key
        expected = 60 if (e.node == "K4" or e.key in SLOW) else 72
        assert e.bpm == expected, e.key
