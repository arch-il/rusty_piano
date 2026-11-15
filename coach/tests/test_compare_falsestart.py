from pathlib import Path

from rusty_piano_coach.compare import ScoreNote, analyse, expected_notes, load_score
from rusty_piano_coach.sessions import PlayedNote

FIX = Path(__file__).parent / "analysis_fixtures"


def _expected():
    return expected_notes(load_score(FIX / "analysis_repeat.musicxml"))[0]


def test_false_start_before_repeat_is_extra():
    expected = _expected()
    false_start = [PlayedNote(69, 1200, 1600, 60), PlayedNote(69, 1700, 2100, 60)]
    body = [PlayedNote(n.pitch, 3000 + 500 * n.q, 3400 + 500 * n.q, 60) for n in expected if n.seq in (0, 1)]
    r = analyse(expected, false_start + body)
    rows = {x["start_ms"]: x for x in r["notes"] if x["start_ms"] is not None}
    assert rows[1200.0]["kind"] == "extra" and rows[1700.0]["kind"] == "extra"
    for p in body:
        row = rows[float(p.start_ms)]
        assert row["kind"] == "match"
        assert row["pass"] == 1
        assert row["seq"] in (0, 1)
    s = r["summary"]
    assert (s["matched"], s["extra"], s["wrong"], s["missed"]) == (8, 2, 0, 0)


def _repeating(pitches, gap_after):
    expected = [
        ScoreNote(p, float(i), 500.0 * i, 120.0, i // 4 + 1, 1, 0, float(i % 4), 0, i, None)
        for i, p in enumerate(pitches)
    ]
    played = [
        PlayedNote(n.pitch, 1000 + 500 * n.seq + (800 if n.seq >= gap_after else 0), 1400 + 500 * n.seq + (800 if n.seq >= gap_after else 0), 60)
        for n in expected
    ]
    return analyse(expected, played)["summary"]


def test_hesitation_in_alberti_opening_is_kept():
    s = _repeating([60, 67, 64, 67] * 4, 4)
    assert (s["matched"], s["extra"]) == (16, 0)


def test_hesitation_in_repeated_single_note_is_kept():
    s = _repeating([60] * 8, 1)
    assert (s["matched"], s["extra"]) == (8, 0)


def test_hesitation_in_two_note_pattern_is_kept():
    s = _repeating([60, 62] * 4, 2)
    assert (s["matched"], s["extra"]) == (8, 0)


def test_hesitation_at_the_start_is_kept():
    expected = _expected()
    played = [
        PlayedNote(n.pitch, 1000 + 500 * n.q + (1000 if n.q >= 2 else 0), 1400 + 500 * n.q + (1000 if n.q >= 2 else 0), 60)
        for n in expected
        if n.seq in (0, 1)
    ]
    r = analyse(expected, played)
    assert r["summary"]["extra"] == 0
    assert r["summary"]["matched"] == 8
    assert all(x["pass"] == 1 for x in r["notes"] if x["kind"] == "match")
