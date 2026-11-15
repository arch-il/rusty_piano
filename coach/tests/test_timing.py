import json
from pathlib import Path

import pytest

from rusty_piano_coach import attempts, reports, timing
from rusty_piano_coach.compare import analyse, expected_notes, load_score
from rusty_piano_coach.sessions import PlayedNote

from test_attempts import valid_attempt

SETTINGS_JSON = Path(__file__).parents[1] / "web" / "src" / "follower-settings.json"
FIXTURE = Path(__file__).parent / "analysis_fixtures" / "analysis_repeat.musicxml"


@pytest.mark.parametrize(
    "offset, score",
    [(0, 100), (20, 100), (-20, 100), (80, 74), (120, 57), (-110, 61), (135, 50), (-135, 50), (250, 0), (-900, 0),
     (None, None), (float("nan"), None), ("12", None), (True, None)],
)
def test_score_matches_the_web_page(offset, score):
    assert timing.timing_score(offset) == score


def test_score_falls_with_the_offset_and_the_curve_bends_it():
    scores = [timing.timing_score(d) for d in range(0, 301, 5)]
    assert scores == sorted(scores, reverse=True)
    kind = dict(timing.DEFAULT_CURVE, curve=2.0)
    strict = dict(timing.DEFAULT_CURVE, curve=0.5)
    assert timing.timing_score(80, kind) > timing.timing_score(80) > timing.timing_score(80, strict)


def test_defaults_match_follower_settings_json():
    t = json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))["timing"]
    assert timing.DEFAULT_CURVE == {"perfect_ms": t["perfectMs"], "zero_ms": t["zeroMs"], "curve": t["curve"]}
    live = json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))["live"]
    assert timing.DEFAULT_ON_TIME_MS == live["onTimeMs"]


def test_outcome_is_derived_from_the_raw_offset():
    assert timing.outcome_of(80) == "hit"
    assert timing.outcome_of(81) == "late"
    assert timing.outcome_of(-81) == "early"
    assert timing.step_outcome({"offset_ms": 120}) == "late"
    assert timing.step_outcome({"offset_ms": 120, "outcome": "hit"}) == "hit"
    assert timing.step_outcome({"offset_ms": 120}, mode="wait") is None
    assert timing.step_outcome({"offset_ms": None}) is None


def test_curve_of_reads_the_attempt_or_falls_back():
    assert timing.curve_of(valid_attempt()) == timing.DEFAULT_CURVE
    a = valid_attempt()
    a["settings"]["timing"] = {"perfect_ms": 10, "zero_ms": 110, "curve": 1, "red_score": 30, "green_score": 90}
    assert timing.curve_of(a) == {"perfect_ms": 10.0, "zero_ms": 110.0, "curve": 1.0}
    a["settings"]["timing"] = {"perfect_ms": 100, "zero_ms": 50, "curve": 1}
    assert timing.curve_of(a) == timing.DEFAULT_CURVE
    assert timing.curve_of(None) == timing.DEFAULT_CURVE


def test_old_attempts_still_load_and_get_a_score_from_their_offsets(tmp_path):
    old = valid_attempt()
    old["steps"].append({**old["steps"][0], "step": 1, "bar": 2, "offset_ms": -135, "outcome": "early", "result": "early"})
    old["steps"].append({**old["steps"][0], "step": 2, "bar": 2, "offset_ms": None, "outcome": "missed", "result": "missed"})
    assert all("timing_score" not in s for s in old["steps"])
    saved = attempts.save_attempt(tmp_path, old)
    loaded = attempts.load_attempt(tmp_path, saved["id"])
    t = timing.attempt_timing(loaded)
    assert t["timing_score"] == 75
    assert t["scored_steps"] == 2
    assert t["bars"] == [
        {"loop": 1, "bar": 1, "pass": 1, "timing_score": 100},
        {"loop": 1, "bar": 2, "pass": 1, "timing_score": 50},
    ]


def test_old_wait_attempt_has_no_score_and_new_steps_use_their_saved_score():
    wait = valid_attempt(mode="wait")
    wait["steps"][0]["offset_ms"] = None
    assert timing.attempt_timing(wait)["timing_score"] is None
    new = valid_attempt()
    new["steps"][0]["timing_score"] = 42
    assert timing.attempt_timing(new)["timing_score"] == 42
    new["steps"][0]["timing_score"] = None
    assert timing.attempt_timing(new)["timing_score"] is None


def test_analysis_scores_notes_bars_and_summary():
    score = load_score(FIXTURE)
    expected, _, _ = expected_notes(score)
    played = [PlayedNote(n.pitch, 1000 + 500 * n.q, 1400 + 500 * n.q, 60) for n in expected]
    r = analyse(expected, played)
    assert all(n["timing_score"] == 100 for n in r["notes"] if n["kind"] == "match")
    assert all(b["timing_score"] == 100 for b in r["bars"])
    assert r["summary"]["timing_score"] == 100
    assert r["timing"] == {"curve": timing.DEFAULT_CURVE, "timing_score": 100}

    # one note 135 ms late against a steady take scores about 50, and only its bar drops
    late = list(played)
    i = next(k for k, n in enumerate(expected) if n.seq == 2)
    p = late[i]
    late[i] = PlayedNote(p.pitch, p.start_ms + 135, p.end_ms + 135, p.velocity)
    r = analyse(expected, late)
    note = next(n for n in r["notes"] if n["start_ms"] == round(p.start_ms + 135, 1))
    assert 45 <= note["timing_score"] <= 55
    by_seq = {b["seq"]: b["timing_score"] for b in r["bars"]}
    assert by_seq[2] < 100
    assert all(v >= 95 for s, v in by_seq.items() if s != 2)


def test_report_shows_timing_in_json_and_markdown():
    score = load_score(FIXTURE)
    expected, _, _ = expected_notes(score)
    played = [PlayedNote(n.pitch, 1000 + 500 * n.q, 1400 + 500 * n.q, 60) for n in expected]
    analysis = analyse(expected, played)
    follower = timing.attempt_timing(valid_attempt())
    report = reports.build_report(
        analysis,
        input_info={"kind": "midi", "midi_path": "C:/x/session-1.mid", "attempt_id": None},
        score_info={"id": None, "title": "Piece", "file": "C:/x/piece.musicxml", "score_bpm": 120},
        options={},
        expansion={"method": "m", "play_order": [1], "warnings": []},
        attempt_timing=follower,
        stem="take",
    )
    assert report["timing"]["timing_score"] == 100
    assert report["timing"]["follower"]["timing_score"] == 100
    assert "Timing score: 100 of 100 (follower: 100 over 1 steps)" in reports.headline_lines(report)
    md = reports.markdown_summary(report)
    assert "| Offset ms | Timing | Velocity |" in md
    assert "| 100 |" in md
