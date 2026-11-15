from pathlib import Path

from rusty_piano_coach import reports
from rusty_piano_coach.compare import analyse, expected_notes, load_score
from rusty_piano_coach.sessions import PlayedNote

FIX = Path(__file__).parent / "analysis_fixtures"


def _tempo_analysis():
    expected = expected_notes(load_score(FIX / "analysis_tempo.musicxml"))[0]
    played = [PlayedNote(n.pitch, 1000 + n.score_ms, 1300 + n.score_ms, 60) for n in expected]
    return analyse(expected, played)


def test_tempo_change_has_no_drift():
    r = _tempo_analysis()
    assert r["summary"]["written_tempos"] == [120.0, 60.0]
    assert r["tempo"]["written_tempos"] == [120.0, 60.0]
    assert abs(r["summary"]["drift_bpm_per_bar"]) < 0.5
    assert 0.98 <= r["summary"]["speed"] <= 1.02
    assert [b["tempo"] for b in r["bars"]] == ["steady"] * 4
    assert r["bars"][2]["bpm"] == 60.0
    for b in r["bars"]:
        assert "_speed" not in b and "_bpm" not in b


def test_single_tempo_list():
    expected = expected_notes(load_score(FIX / "analysis_repeat.musicxml"))[0]
    played = [PlayedNote(n.pitch, 1000 + 500 * n.q, 1300 + 500 * n.q, 60) for n in expected]
    r = analyse(expected, played)
    assert r["summary"]["written_tempos"] == [120.0]


def test_headline_names_written_tempos():
    report = reports.build_report(
        _tempo_analysis(),
        input_info={"kind": "midi", "midi_path": "x.mid", "attempt_id": None},
        score_info={"id": None, "title": "T", "file": "t.musicxml", "score_bpm": 120.0},
        options={},
        expansion=None,
        stem="x",
    )
    assert "Tempo: 100% of the written tempo (120 then 60 bpm)" in reports.headline_lines(report)
