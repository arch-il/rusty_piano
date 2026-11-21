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
        nodes=["R4", "R5", "R6", "R7", "R11", "R12", "R13", "R14"],
    )


def _by_key():
    return {e.key: e for e in track_reading.EXERCISES}


def test_house_rules(loaded):
    assert len(loaded) == 40


def test_counts(loaded):
    counts = {}
    for e in track_reading.EXERCISES:
        counts[e.node] = counts.get(e.node, 0) + 1
    assert counts == {"R4": 5, "R5": 6, "R6": 5, "R7": 6, "R11": 5, "R12": 5, "R13": 4, "R14": 4}
    assert [e.key for e in track_reading.EXERCISES] == [
        "r4-landmarks", "r4-middle-c", "r4-read-1", "r4-read-2", "r4-read-3",
        "r5-seconds", "r5-thirds", "r5-fourths-fifths", "r5-intervals-lh", "r5-read-1", "r5-sixths-octaves",
        "r6-high-c", "r6-below-treble", "r6-low-c", "r6-above-bass", "r6-read-1",
        "r7-g-rh", "r7-g-lh", "r7-f-rh", "r7-f-lh", "r7-read-g", "r7-read-f",
        "r11-sharps", "r11-flats", "r11-naturals", "r11-lh", "r11-read",
        "r12-d-rh", "r12-bb-lh", "r12-a-major", "r12-eb-major", "r12-naturals",
        "r13-a-minor-rh", "r13-e-minor-lh", "r13-d-minor", "r13-relative",
        "r14-repeat", "r14-endings", "r14-dc-fine", "r14-ds-coda",
    ]


def test_key_signatures():
    by = _by_key()
    expected = {
        "r7-g-rh": 1, "r7-g-lh": 1, "r7-f-rh": -1, "r7-f-lh": -1, "r7-read-g": 1, "r7-read-f": -1,
        "r12-d-rh": 2, "r12-bb-lh": -2, "r12-a-major": 3, "r12-eb-major": -3, "r12-naturals": 1,
        "r13-a-minor-rh": 0, "r13-e-minor-lh": 1, "r13-d-minor": -1, "r13-relative": 0,
    }
    for e in track_reading.EXERCISES:
        assert e.fifths == expected.get(e.key, 0), e.key
    for e in track_reading.EXERCISES:
        text = e.rh + " " + e.lh
        if e.fifths == 1 and e.node == "R7":
            assert re.search(r"\bF\d", text) is None, e.key
        if e.fifths == -1 and e.node == "R7":
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


def test_modes():
    for e in track_reading.EXERCISES:
        assert e.mode == "wait", e.key


def test_naturals_written():
    by = _by_key()
    for k in ("r11-naturals", "r12-naturals"):
        assert "<accidental>natural</accidental>" in by[k].musicxml(), k


def test_r4_read_wider_range():
    ex = _by_key()["r4-read-1"]
    assert re.search(r"(A4|B4|C5)", ex.rh) or re.search(r"(A3|B3|C4)", ex.lh)


def test_r14_bar_orders(loaded):
    expect = {
        "r14-repeat": [1, 2, 3, 4, 1, 2, 3, 4],
        "r14-endings": [1, 2, 3, 1, 2, 4],
        "r14-dc-fine": [1, 2, 3, 4, 1, 2],
        "r14-ds-coda": [1, 2, 3, 4, 2, 3, 5],
    }
    for k, order in expect.items():
        assert compare.expected_notes(loaded[k])[1] == order, k
