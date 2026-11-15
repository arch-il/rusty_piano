import re

import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach import compare
from rusty_piano_coach.library.genx import track_rhythm

NODES = ["T3", "T4", "T5", "T6", "T7"]
KEYS = [
    "t3-eighths-rh", "t3-eighths-lh", "t3-quarters-eighths", "t3-eighths-34", "t3-hot-cross-buns",
    "t4-quarter-rests", "t4-half-rests", "t4-after-rest", "t4-rests-lh", "t4-bar-rest",
    "t5-dotted-half-34", "t5-dotted-half", "t5-dotted-quarter", "t5-dotted-quarter-lh", "t5-dotted-34",
    "t6-ties-across", "t6-ties-inside", "t6-syncopation", "t6-tied-eighths", "t6-ties-lh",
    "t7-triplets", "t7-triplets-eighths", "t7-quarters-triplets", "t7-triplets-lh", "t7-triplets-34",
]
BY_KEY = {e.key: e for e in track_rhythm.EXERCISES}


@pytest.fixture(scope="module")
def loaded(tmp_path_factory):
    return check_exercises(track_rhythm.EXERCISES, tmp_path_factory.mktemp("rhythm"),
                           track="rhythm", nodes=NODES)


def test_house_rules(loaded):
    assert len(loaded) == 25


def test_counts_and_keys(loaded):
    for node in NODES:
        assert sum(1 for e in track_rhythm.EXERCISES if e.node == node) == 5
    assert [e.key for e in track_rhythm.EXERCISES] == KEYS


def test_features():
    for e in track_rhythm.EXERCISES:
        text = e.rh or e.lh
        if e.node == "T4":
            assert re.search(r"(^|\s)r(:|\s|$)", text), e.key
        elif e.node == "T5":
            assert re.search(r":[hqe]\.", text), e.key
        elif e.node == "T6" and e.key != "t6-syncopation":
            assert "~" in text, e.key
        elif e.node == "T7":
            assert ":3e" in text, e.key


def test_ties_skipped(loaded):
    assert count_notes(loaded["t6-ties-across"], "right") == 8


def test_triplet_timing(loaded):
    qs = [n.q for n in compare.expected_notes(loaded["t7-triplets"], hands="right")[0]]
    assert qs[:3] == pytest.approx([0, 1 / 3, 2 / 3])


def test_meta():
    for e in track_rhythm.EXERCISES:
        assert e.mode == "live", e.key
        if e.node == "T7":
            assert e.bpm == 60, e.key
        else:
            assert e.bpm == 72, e.key
    threes = {e.key for e in track_rhythm.EXERCISES if e.time == "3/4"}
    assert threes == {"t3-eighths-34", "t5-dotted-half-34", "t5-dotted-34", "t7-triplets-34"}
