from pathlib import Path

from rusty_piano_coach.analyse_cli import loop_speeds_of
from rusty_piano_coach.compare import analyse, expected_notes, load_score
from rusty_piano_coach.sessions import PlayedNote

FIXTURE = Path(__file__).parent / "analysis_fixtures" / "analysis_repeat.musicxml"
SPEEDS = [1.0, 1.1, 1.2]


def ramp_practice(cycles, start=60):
    return {"tempo": {"percent": start, "ramp": {"cycles": [{"cycle": c, "percent": p} for c, p in cycles]}}}


def ramped_played(expected):
    return [PlayedNote(n.pitch, 500 + n.score_ms, 500 + n.score_ms + 200, 60) for n in expected]


def test_loop_speeds_of():
    p = ramp_practice([(1, 60), (2, 65), (3, 70)])
    assert loop_speeds_of(p, 3) == [1.0, 65 / 60, 70 / 60]
    assert loop_speeds_of({"tempo": {"percent": 60, "ramp": None}}, 3) is None
    p = ramp_practice([(1, 60), (3, 70)])
    assert loop_speeds_of(p, 3) == [1.0, 1.0, 70 / 60]
    p = ramp_practice([(1, 60), (2, 65)])
    assert loop_speeds_of(p, 4) == [1.0, 65 / 60, 65 / 60, 65 / 60]


def test_ramped_times_fit():
    score = load_score(FIXTURE)
    expected, _, _ = expected_notes(score, bars=(1, 2), loops=3, loop_speeds=SPEEDS)
    r = analyse(expected, ramped_played(expected))
    s = r["summary"]
    assert s["matched"] == len(expected)
    assert s["rushed_bars"] == [] and s["dragged_bars"] == []
    assert abs(s["drift_bpm_per_bar"]) < 0.5


def test_old_bug_without_speeds():
    score = load_score(FIXTURE)
    ramped, _, _ = expected_notes(score, bars=(1, 2), loops=3, loop_speeds=SPEEDS)
    flat, _, _ = expected_notes(score, bars=(1, 2), loops=3)
    s = analyse(flat, ramped_played(ramped))["summary"]
    assert s["rushed_bars"]


def test_none_speeds_same_as_old():
    score = load_score(FIXTURE)
    a, _, _ = expected_notes(score, bars=(1, 2), loops=2)
    b, _, _ = expected_notes(score, bars=(1, 2), loops=2, loop_speeds=None)
    c, _, _ = expected_notes(score, bars=(1, 2), loops=2, loop_speeds=[1.0, 1.0])
    assert a == b == c
