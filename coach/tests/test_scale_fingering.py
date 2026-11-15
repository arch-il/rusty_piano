import xml.etree.ElementTree as ET

import pytest

from rusty_piano_coach.library import fingering, scale_fingering, scales
from rusty_piano_coach.library.index import Library

BLACK = {1, 3, 6, 8, 10}
THUMB_OK = {("arp-major", 6), ("arp-minor", 3)}
GOLDEN = [
    ("c-major-1oct-rh", "rh", "1 2 3 1 2 3 4 5 4 3 2 1 3 2 1"),
    ("c-major-1oct-lh", "lh", "5 4 3 2 1 3 2 1 2 3 1 2 3 4 5"),
    ("c-major-1oct-ht", "rh", "1 2 3 1 2 3 4 5 4 3 2 1 3 2 1"),
    ("c-major-1oct-ht", "lh", "5 4 3 2 1 3 2 1 2 3 1 2 3 4 5"),
    ("c-major-2oct-rh", "rh", "1 2 3 1 2 3 4 1 2 3 1 2 3 4 5 4 3 2 1 3 2 1 4 3 2 1 3 2 1"),
    ("f-major-1oct-rh", "rh", "1 2 3 4 1 2 3 4 3 2 1 4 3 2 1"),
    ("bb-major-1oct-lh", "lh", "3 2 1 4 3 2 1 3 1 2 3 4 1 2 3"),
    ("fs-minor-melodic-1oct-rh", "rh", "2 3 1 2 3 4 1 3 2 1 3 2 1 4 2"),
    ("gs-minor-natural-1oct-lh", "lh", "3 2 1 3 2 1 4 3 4 1 2 3 1 2 3"),
    ("c-arp-major-2oct-lh", "lh", "5 4 2 1 4 2 1 2 4 1 2 4 5"),
    ("db-arp-major-1oct-rh", "rh", "2 1 2 4 2 1 2"),
    ("c-chromatic-1oct-rh", "rh", "1 3 1 3 1 2 3 1 3 1 3 1 2 1 3 1 3 1 3 2 1 3 1 3 1"),
    ("c-chromatic-1oct-lh", "lh", "1 3 1 3 2 1 3 1 3 1 3 2 1 2 3 1 3 1 3 1 2 3 1 3 1"),
]


def _runs(sc):
    for hand in ("rh", "lh"):
        if sc.hand in (hand, "ht"):
            notes = scales.hand_notes(sc, hand)
            yield hand, notes, scale_fingering.fingers(sc, hand, notes)


@pytest.fixture(scope="module")
def runs():
    return {sc.key: list(_runs(sc)) for sc in scales.CATALOGUE}


def test_lengths_and_range(runs):
    for key, rs in runs.items():
        assert rs
        for hand, notes, fs in rs:
            assert len(fs) == len(notes), key
            assert all(1 <= f <= 5 for f in fs), key


def test_no_repeated_finger_on_neighbours(runs):
    bad = []
    for key, rs in runs.items():
        for hand, notes, fs in rs:
            for i in range(len(notes) - 1):
                if notes[i].midi != notes[i + 1].midi and fs[i] == fs[i + 1]:
                    bad.append((key, hand, i))
    assert not bad, bad[:20]


def test_no_thumb_on_black_keys(runs):
    bad = []
    for sc in scales.CATALOGUE:
        if (sc.kind, sc.pc) in THUMB_OK:
            continue
        for hand, notes, fs in runs[sc.key]:
            for i, n in enumerate(notes):
                if fs[i] == 1 and n.midi % 12 in BLACK:
                    bad.append((sc.key, hand, i))
    assert not bad, bad[:20]


@pytest.mark.parametrize("key,hand,expected", GOLDEN)
def test_golden(runs, key, hand, expected):
    got = next(fs for h, _, fs in runs[key] if h == hand)
    assert " ".join(map(str, got)) == expected


@pytest.fixture(scope="module")
def parsed():
    return {sc.key: fingering.score_notes(ET.fromstring(scales.musicxml(sc).encode("utf-8"))) for sc in scales.CATALOGUE}


def test_keys_match_score(parsed):
    for sc in scales.CATALOGUE:
        mine = scale_fingering.scale_notes(sc)
        theirs = parsed[sc.key]
        assert len(mine) == len(theirs), sc.key
        assert sorted((n["m"], n["q"], n["s"], n["p"]) for n in mine) == sorted(
            (n["m"], n["q"], n["s"], n["p"]) for n in theirs), sc.key


def test_generate_writes_sidecars(tmp_path):
    lib = Library(tmp_path / "lib")
    keys = {"c-major-1oct-rh", "fs-minor-melodic-1oct-rh"}
    scales.generate(lib, keys=keys)
    out = tmp_path / "lib" / "files" / "scales"
    mtimes = {}
    for key in keys:
        path = out / f"{key}.musicxml"
        st = fingering.read_status(path)
        assert st["status"] == "ready"
        assert st["source"] == "textbook"
        assert st["notes"] == scale_fingering.scale_notes(scales.BY_KEY[key])
        assert st["error"] is None
        mtimes[key] = fingering.sidecar_path(path).stat().st_mtime_ns
    scales.generate(lib, keys=keys)
    for key in keys:
        assert fingering.sidecar_path(out / f"{key}.musicxml").stat().st_mtime_ns == mtimes[key]
    lib.close()
