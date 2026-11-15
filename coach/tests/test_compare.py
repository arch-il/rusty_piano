from pathlib import Path

import pytest

from rusty_piano_coach import compare
from rusty_piano_coach.compare import align, analyse, expected_notes, load_score
from rusty_piano_coach.sessions import PlayedNote

FIXTURE = Path(__file__).parent / "analysis_fixtures" / "analysis_repeat.musicxml"
TWO_HANDS = Path(__file__).parent / "fixtures" / "two_hands_e_minor.musicxml"
WEB = Path(__file__).parents[1] / "web" / "tests" / "fixtures"


def perfect(expected):
    return [PlayedNote(n.pitch, 1000 + 500 * n.q, 1400 + 500 * n.q, 60) for n in expected]


def messy_take(expected):
    played = []
    for n in expected:
        if n.q == 21:
            continue
        start = 1000 + 500 * n.q
        vel = 60
        if n.seq == 4:
            start = 1000 + 500 * 16 + 300 * (n.q - 16)
            vel = 100
        elif n.seq == 5:
            start = 1000 + 500 * n.q - 800
        pitch = 70 if n.q == 6 else n.pitch
        played.append(PlayedNote(pitch, start, start + 400, vel))
    played.append(PlayedNote(61, 5750, 5950, 60))
    return played


def test_analysis_repeat_report():
    score = load_score(FIXTURE)
    expected, order, method = expected_notes(score)
    assert order == [1, 2, 1, 2, 3, 4]
    assert method == "music21.expandRepeats"
    assert len(expected) == 24
    assert score.score_bpm == 120
    r = analyse(expected, messy_take(expected))
    s = r["summary"]
    assert (s["matched"], s["wrong"], s["missed"], s["extra"], s["not_reached"]) == (22, 1, 1, 1, 0)
    assert s["accuracy"] == round(22 / 24, 3)
    wrong = next(x for x in r["notes"] if x["kind"] == "wrong")
    assert (wrong["expected"], wrong["played"], wrong["bar"], wrong["pass"]) == (69, 70, 2, 1)
    missed = next(x for x in r["notes"] if x["kind"] == "missed")
    assert (missed["expected"], missed["bar"]) == (76, 4)
    extra = next(x for x in r["notes"] if x["kind"] == "extra")
    assert (extra["played"], extra["seq"], extra["bar"], extra["pass"]) == (61, 2, 1, 2)
    bars = r["bars"]
    assert bars[4]["tempo"] == "rushed"
    assert bars[4]["velocity_mean"] == 100
    for i in (0, 1, 2, 3, 5):
        assert bars[i]["tempo"] == "steady"
    assert bars[0]["dynamic"] == "p"
    assert bars[4]["dynamic"] == "f"
    assert 110 <= s["bpm"] <= 140
    assert s["rushed_bars"] == [3]


def test_partial_take():
    expected, _, _ = expected_notes(load_score(FIXTURE))
    played = perfect(expected)[:8]
    s = analyse(expected, played)["summary"]
    assert (s["matched"], s["not_reached"], s["missed"]) == (8, 16, 0)
    s = analyse(expected, played, free_ends=False)["summary"]
    assert s["missed"] == 16


def test_empty_played():
    expected, _, _ = expected_notes(load_score(FIXTURE))
    r = analyse(expected, [])
    assert r["summary"]["accuracy"] is None
    assert r["summary"]["not_reached"] == 24


def test_hands():
    score = load_score(TWO_HANDS)
    right, _, _ = expected_notes(score, hands="right")
    left, _, _ = expected_notes(score, hands="left")
    both, _, _ = expected_notes(score)
    assert right and left
    assert all(n.part == 0 for n in right)
    assert all(n.part >= 1 for n in left)
    assert len(both) == len(right) + len(left)
    with pytest.raises(ValueError):
        expected_notes(score, hands="x")


def test_bar_range_and_loops():
    score = load_score(FIXTURE)
    notes, order, method = expected_notes(score, bars=(1, 2), loops=2)
    assert order == [1, 2, 1, 2]
    assert method == "bar-range"
    assert len(notes) == 16
    assert [n.loop for n in notes] == [1] * 8 + [2] * 8
    assert all(n.pass_no == 1 for n in notes)
    assert [n.q for n in notes] == list(range(16))
    _, order, _ = expected_notes(score, bars=(3, 3), from_bar_to_end=True)
    assert order == [3, 4]


def test_max_cells(monkeypatch):
    expected, _, _ = expected_notes(load_score(FIXTURE))
    monkeypatch.setattr(compare, "MAX_CELLS", 10)
    with pytest.raises(ValueError, match="--bars"):
        align(expected, perfect(expected))


def test_music21_play_order_on_web_fixtures():
    orders = {}
    for name in ("follower_repeats", "follower_dc_fine", "follower_ds_coda"):
        orders[name] = expected_notes(load_score(WEB / f"{name}.musicxml"))[1]
    assert orders["follower_repeats"] == [1, 2, 1, 3, 4, 5, 1, 2, 1, 3, 4, 5, 6]
    assert orders["follower_dc_fine"] == [1, 2, 1, 2, 3, 4, 1, 2]
    assert orders["follower_ds_coda"] == [1, 2, 3, 4, 2, 3, 5, 6]


def test_prelude_notes_far_off_the_tempo_are_extra_not_matched():
    expected, _, _ = expected_notes(load_score(FIXTURE))
    real = [PlayedNote(n.pitch, 10000 + 500 * (n.q - 8), 10000 + 500 * (n.q - 8) + 400, 60)
            for n in expected if n.seq >= 2]
    bar2 = [n for n in expected if n.seq == 1]
    prelude = [PlayedNote(n.pitch, 2000 + 1000 * i, 2000 + 1000 * i + 400, 60) for i, n in enumerate(bar2)]
    r = analyse(expected, prelude + real)
    pre_ms = {p.start_ms for p in prelude}
    assert all(x["kind"] == "extra" for x in r["notes"] if x["start_ms"] in pre_ms)
    assert all(x["kind"] == "not_reached" for x in r["notes"] if x["seq"] in (0, 1) and x["kind"] != "extra")
    s = r["summary"]
    assert s["missed"] == 0 and s["wrong"] == 0
    real_ms = {p.start_ms for p in real}
    assert all(x["kind"] == "match" for x in r["notes"] if x["start_ms"] in real_ms)
    assert all(b["bpm"] is None or b["bpm"] >= 60 for b in r["bars"])
    assert abs(s["drift_bpm_per_bar"]) < 1.0
