from datetime import datetime, timezone

from rusty_piano_coach import reports

NOW = datetime(2026, 11, 4, 22, 0, 5, 700000, tzinfo=timezone.utc)

SUMMARY = {
    "score_notes": 2, "played_notes": 2, "matched": 2, "wrong": 0, "missed": 0, "extra": 0, "not_reached": 0,
    "accuracy": None, "bpm": None, "speed": None, "mean_abs_offset_ms": None, "drift_bpm_per_bar": None,
    "first_half_bpm": None, "second_half_bpm": None, "rushed_bars": [], "dragged_bars": [],
    "velocity_mean": None, "duration_ms": None,
}
ANALYSIS = {
    "summary": SUMMARY,
    "notes": [
        {"kind": "wrong", "bar": 1, "beat": 1, "expected": 60, "played": 61},
        {"kind": "missed", "bar": 2, "beat": 2, "expected": 62, "played": None},
    ],
    "bars": [{
        "seq": 1, "bar": 1, "pass": 1, "loop": 1, "notes": 2, "matched": 0, "wrong": 1, "missed": 0, "extra": 0,
        "mean_offset_ms": None, "bpm": None, "tempo": None, "velocity_mean": None, "dynamic": None,
    }],
    "tempo": {"bpm": None},
    "warnings": ["w1"],
}


def make(stem="take"):
    return reports.build_report(
        ANALYSIS,
        input_info={"kind": "midi", "midi_path": "C:/x/session-1.mid", "attempt_id": None},
        score_info={"id": None, "title": None, "file": "C:/x/piece.musicxml", "score_bpm": None},
        options={"hands": "both"},
        expansion={"method": "m", "play_order": [1], "warnings": []},
        extra_warnings=["w2"],
        stem=stem,
        now=NOW,
    )


def test_report_id_and_sanitising():
    assert reports.report_id("take", NOW) == "report-20261104-220005-take"
    assert reports.report_id("my take:1", NOW) == "report-20261104-220005-my-take-1"
    assert reports.report_id("::", NOW) == "report-20261104-220005-input"


def test_build_report_key_order():
    report = make()
    assert list(report) == [
        "version", "kind", "id", "created_at", "input", "score", "options", "expansion",
        "summary", "notes", "bars", "tempo", "timing", "attempt_summary", "warnings",
    ]
    assert report["version"] == 1
    assert report["kind"] == "rusty_piano.report"
    assert report["created_at"] == "2026-11-04T22:00:05Z"
    assert report["warnings"] == ["w1", "w2"]


def test_write_report_twice(tmp_path):
    first = reports.write_report(make(), tmp_path / "rep")
    second = reports.write_report(make(), tmp_path / "rep")
    assert first[0].name == "report-20261104-220005-take.json"
    assert second[0].name == "report-20261104-220005-take-2.json"
    assert not list((tmp_path / "rep").glob("*.tmp"))
    text = second[1].read_text(encoding="utf-8")
    assert "# Practice report" in text
    assert "| Bar |" in text
    assert "expected C4, played C#4" in text


def test_headline_lines_with_no_accuracy():
    lines = reports.headline_lines(make())
    assert lines[0] == "Analysed session-1.mid against piece.musicxml"
    assert "accuracy -%" in lines[1]
    assert "Tempo: - (not enough matched notes)" in lines
    assert "Warning: w1" in lines
