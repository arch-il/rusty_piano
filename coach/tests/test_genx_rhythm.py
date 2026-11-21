import hashlib
import re

import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach import compare
from rusty_piano_coach.library.genx import track_rhythm
from rusty_piano_coach.library.genx.core import write

NODES = ["T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11"]
KEYS = [
    "t3-eighths-rh", "t3-eighths-lh", "t3-quarters-eighths", "t3-eighths-34", "t3-hot-cross-buns",
    "t4-quarter-rests", "t4-half-rests", "t4-rests-lh", "t4-bar-rest", "t4-pickup",
    "t5-dotted-half-34", "t5-dotted-half", "t5-dotted-quarter", "t5-dotted-quarter-lh",
    "t6-ties-across", "t6-ties-inside", "t6-syncopation", "t6-tied-eighths", "t6-ties-lh",
    "t7-triplets", "t7-triplets-eighths", "t7-quarters-triplets", "t7-triplets-lh",
    "t8-sixteenths-rh", "t8-eighth-two-sixteenths", "t8-two-sixteenths-eighth", "t8-dotted-eighth",
    "t8-sixteenths-lh",
    "t9-dotted-quarters", "t9-six-eighths", "t9-long-short", "t9-lh", "t9-mixed",
    "t10-two-four-rh", "t10-two-four-lh", "t10-cut-time", "t10-cut-time-both",
    "t11-long-short", "t11-swing-scale", "t11-swing-offbeat", "t11-swing-lh",
]
COUNTS = {"T3": 5, "T4": 5, "T5": 4, "T6": 5, "T7": 4, "T8": 5, "T9": 5, "T10": 4, "T11": 4}
PINS = {
    "t3-eighths-rh": "51b66cffb7cf895f",
    "t3-eighths-lh": "2e5cc8c13f073d02",
    "t3-quarters-eighths": "50e5b5010e7234b6",
    "t3-eighths-34": "6232d76fad5574ca",
    "t3-hot-cross-buns": "90d9a493ed8d383f",
}
BY_KEY = {e.key: e for e in track_rhythm.EXERCISES}


@pytest.fixture(scope="module")
def loaded(tmp_path_factory):
    return check_exercises(track_rhythm.EXERCISES, tmp_path_factory.mktemp("rhythm"),
                           track="rhythm", nodes=NODES)


def test_house_rules(loaded):
    assert len(loaded) == 41


def test_counts_and_keys(loaded):
    for node in NODES:
        assert sum(1 for e in track_rhythm.EXERCISES if e.node == node) == COUNTS[node]
    assert [e.key for e in track_rhythm.EXERCISES] == KEYS


def test_features():
    for e in track_rhythm.EXERCISES:
        text = e.rh or e.lh
        if e.key == "t4-pickup":
            assert e.pickup == 12
        elif e.node == "T4":
            assert re.search(r"(^|\s)r(:|\s|$)", text), e.key
        elif e.node == "T5":
            assert re.search(r":[hqe]\.", text), e.key
        elif e.node == "T6" and e.key != "t6-syncopation":
            assert "~" in text, e.key
        elif e.node == "T7":
            assert ":3e" in text, e.key
        elif e.node == "T8":
            assert ":s" in text, e.key
        elif e.node == "T11":
            assert ":3e" in text and "~" in text, e.key


def test_ties_skipped(loaded):
    assert count_notes(loaded["t6-ties-across"], "right") == 8


def test_triplet_timing(loaded):
    qs = [n.q for n in compare.expected_notes(loaded["t7-triplets"], hands="right")[0]]
    assert qs[:3] == pytest.approx([0, 1 / 3, 2 / 3])


def test_meta():
    bpms = {"T7": 60, "T8": 60, "T9": 90, "T11": 72}
    for e in track_rhythm.EXERCISES:
        assert e.mode == "live", e.key
        if e.node == "T10":
            assert e.bpm == (100 if e.time == "2/2" else 80), e.key
        else:
            assert e.bpm == bpms.get(e.node, 72), e.key
    threes = {e.key for e in track_rhythm.EXERCISES if e.time == "3/4"}
    assert threes == {"t3-eighths-34", "t5-dotted-half-34"}
    assert all(e.time == "6/8" for e in track_rhythm.EXERCISES if e.node == "T9")


def test_t3_pins():
    for key, pin in PINS.items():
        xml = write(BY_KEY[key])
        assert hashlib.sha256(xml.encode("utf-8")).hexdigest()[:16] == pin, key


def test_cut_time_symbol():
    assert 'symbol="cut"' in write(BY_KEY["t10-cut-time"])


def test_sixteenth_beam():
    assert 'number="2"' in write(BY_KEY["t8-sixteenths-rh"])


def test_pickup_measure():
    xml = write(BY_KEY["t4-pickup"])
    first = xml[xml.index("<measure"):xml.index("</measure>")]
    assert "<duration>12</duration>" in first
    assert "<duration>48</duration>" not in first
