import dataclasses

import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach import compare
from rusty_piano_coach.library.genx import track_harmony

NODES = ["M1", "M2", "M3", "M4", "M5"]
FIFTHS = {"m3-g-major-lh": 1, "m3-cadence-rh": 1, "m3-f-major-lh": -1, "m4-ii-v-i-f": -1, "m4-ii-v-i-bb": -2}
BY_KEY = {e.key: e for e in track_harmony.EXERCISES}


@pytest.fixture(scope="module")
def loaded(tmp_path_factory):
    return check_exercises(track_harmony.EXERCISES, tmp_path_factory.mktemp("harmony"),
                           track="harmony", nodes=NODES, per_node=(4, 5))


def test_house_rules(loaded):
    assert len(loaded) == 21


def test_counts():
    counts = {n: sum(e.node == n for e in track_harmony.EXERCISES) for n in NODES}
    assert counts == {"M1": 5, "M2": 4, "M3": 4, "M4": 4, "M5": 4}


def test_symbols_in_xml():
    for ex in track_harmony.EXERCISES:
        assert ex.symbols, ex.key
        assert "<harmony" in ex.musicxml(), ex.key


def test_symbols_do_not_change_notes(tmp_path):
    for ex in track_harmony.EXERCISES:
        bare = dataclasses.replace(ex, symbols="")
        p1, p2 = tmp_path / "a.musicxml", tmp_path / "b.musicxml"
        p1.write_text(ex.musicxml(), encoding="utf-8")
        p2.write_text(bare.musicxml(), encoding="utf-8")
        s1, s2 = compare.load_score(p1), compare.load_score(p2)
        for hand in ("right", "left"):
            assert count_notes(s1, hand) == count_notes(s2, hand), ex.key


def test_fifths():
    for name, ex in BY_KEY.items():
        assert ex.fifths == FIFTHS.get(name, 0), name


def test_blues_symbols():
    for name in ("m5-blues-lh", "m5-blues-melody"):
        assert "12:G7" in BY_KEY[name].symbols
