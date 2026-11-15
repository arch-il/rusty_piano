import pytest

from rusty_piano_coach.library.analyse import AnalysisError, ScoreAnalysis, analyse_file
from rusty_piano_coach.library.difficulty import catalogue_difficulty, round_half_up, score_difficulty


def test_simple_c_major(fixtures_dir):
    a = analyse_file(fixtures_dir / "simple_c_major.musicxml")
    assert a.title == "Simple C Major"
    assert a.composer == "Test Composer"
    assert a.key == "C major"
    assert a.time_signature == "4/4"
    assert a.seconds == 4.0
    assert a.n_notes == 8
    assert a.pitch_range == 12
    assert a.chord_ratio == 0.0
    assert a.staves == 1
    assert a.accidental_ratio == 0.0
    assert a.piano_only is True
    assert score_difficulty(a) == 1


def test_two_hands_e_minor(fixtures_dir):
    a = analyse_file(fixtures_dir / "two_hands_e_minor.musicxml")
    assert a.key == "E minor"
    assert a.time_signature == "3/4"
    assert a.seconds == 6.0
    assert a.n_notes == 7
    assert a.pitch_range == 24
    assert a.chord_ratio == pytest.approx(1 / 6)
    assert a.staves == 2
    assert a.accidental_ratio == pytest.approx(1 / 7)
    assert a.piano_only is True
    assert score_difficulty(a) == 2
    assert score_difficulty(a, 3) == 3


def test_mxl_matches_musicxml(fixtures_dir, make_mxl, tmp_path):
    mxl = make_mxl(fixtures_dir / "simple_c_major.musicxml", tmp_path / "simple.mxl")
    a = analyse_file(mxl)
    assert a.key == "C major"
    assert a.time_signature == "4/4"
    assert a.n_notes == 8


def test_not_music_raises(fixtures_dir):
    with pytest.raises(AnalysisError):
        analyse_file(fixtures_dir / "not_music.xml")


def test_missing_file_raises(tmp_path):
    with pytest.raises(AnalysisError):
        analyse_file(tmp_path / "missing.musicxml")


def make_analysis(n_notes, seconds, pitch_range, chord_ratio, staves, accidental_ratio):
    return ScoreAnalysis(
        title=None,
        composer=None,
        key=None,
        time_signature=None,
        seconds=seconds,
        n_notes=n_notes,
        pitch_range=pitch_range,
        chord_ratio=chord_ratio,
        staves=staves,
        accidental_ratio=accidental_ratio,
        piano_only=True,
    )


def test_difficulty_easy():
    a = make_analysis(20, 20, 7, 0.0, 1, 0.0)
    assert score_difficulty(a) == 1


def test_difficulty_hard():
    a = make_analysis(1000, 50, 60, 0.6, 2, 0.5)
    assert score_difficulty(a) == 5
    assert score_difficulty(a, 1) == 4


def test_difficulty_middle():
    a = make_analysis(180, 20, 30, 0.25, 2, 0.15)
    assert score_difficulty(a) == 3


def test_difficulty_no_notes_is_none():
    a = make_analysis(0, 20, 0, 0.0, 1, 0.0)
    assert score_difficulty(a) is None


def test_catalogue_difficulty():
    assert catalogue_difficulty(1, 818, 234.0) == 1
    assert catalogue_difficulty(2, 1078, 69.0) == 4
    assert catalogue_difficulty(0, 360, 41.4) == 3
    assert catalogue_difficulty(3, None, None) == 5
    assert catalogue_difficulty(None, None, None) is None


def test_round_half_up():
    assert round_half_up(2.5) == 3


def test_post_parse_failure_raises_analysis_error(fixtures_dir, monkeypatch):
    from rusty_piano_coach.library import analyse

    monkeypatch.setattr(analyse, "meter", None)
    with pytest.raises(AnalysisError):
        analyse_file(fixtures_dir / "two_hands_e_minor.musicxml")
