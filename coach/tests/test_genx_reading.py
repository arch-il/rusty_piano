import re

import pytest

from genx_check import check_exercises, count_notes, written_pitches
from rusty_piano_coach import compare
from rusty_piano_coach.library.genx import track_reading


@pytest.fixture(scope="module")
def loaded(tmp_path_factory):
    return check_exercises(
        track_reading.EXERCISES,
        tmp_path_factory.mktemp("reading"),
        track="reading",
        nodes=["R4", "R5", "R6", "R7", "R8"],
    )


def _by_key():
    return {e.key: e for e in track_reading.EXERCISES}


def test_house_rules(loaded):
    assert len(loaded) == 27


def test_counts(loaded):
    counts = {}
    for e in track_reading.EXERCISES:
        counts[e.node] = counts.get(e.node, 0) + 1
    assert counts == {"R4": 5, "R5": 6, "R6": 5, "R7": 6, "R8": 5}
    assert [e.key for e in track_reading.EXERCISES] == [
        "r4-landmarks", "r4-middle-c", "r4-read-1", "r4-read-2", "r4-read-3",
        "r5-seconds", "r5-thirds", "r5-fourths-fifths", "r5-intervals-lh", "r5-read-1", "r5-read-2",
        "r6-high-c", "r6-below-treble", "r6-low-c", "r6-above-bass", "r6-read-1",
        "r7-g-rh", "r7-g-lh", "r7-f-rh", "r7-f-lh", "r7-read-g", "r7-read-f",
        "r8-sight-1", "r8-sight-2", "r8-sight-3", "r8-sight-4", "r8-sight-5",
    ]


def test_key_signatures():
    by = _by_key()
    for e in track_reading.EXERCISES:
        if e.node == "R7":
            assert e.fifths != 0, e.key
        else:
            assert e.fifths == 0, e.key
    for e in track_reading.EXERCISES:
        text = e.rh + " " + e.lh
        if e.fifths == 1:
            assert re.search(r"\bF\d", text) is None, e.key
        if e.fifths == -1:
            assert re.search(r"\bB\d", text) is None, e.key
    assert "F#" in by["r7-g-rh"].rh
    assert "F#" in by["r7-g-lh"].lh
    assert "Bb" in by["r7-f-rh"].rh
    assert "Bb" in by["r7-f-lh"].lh


def test_ledger_lines():
    by = _by_key()
    assert max(written_pitches(by["r6-high-c"])) == 84
    assert min(written_pitches(by["r6-low-c"])) == 36
    assert min(written_pitches(by["r6-below-treble"])) == 57


def test_r4_both_hands(loaded):
    for e in track_reading.EXERCISES:
        if e.node == "R4":
            assert count_notes(loaded[e.key], "right") > 0, e.key
            assert count_notes(loaded[e.key], "left") > 0, e.key


def test_snippets_differ():
    by = _by_key()
    snippets = [by["r4-read-1"].rh, by["r4-read-2"].rh, by["r4-read-3"].rh]
    assert len(set(snippets)) == 3
    sight = [
        by["r8-sight-1"].rh, by["r8-sight-2"].rh, by["r8-sight-3"].lh,
        by["r8-sight-4"].rh, by["r8-sight-5"].rh,
    ]
    assert len(set(sight)) == 5


def test_modes():
    for e in track_reading.EXERCISES:
        if e.node == "R8":
            assert e.mode == "live", e.key
        else:
            assert e.mode == "wait", e.key
    assert _by_key()["r8-sight-5"].time == "3/4"
