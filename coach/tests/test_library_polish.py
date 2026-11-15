import pytest

from rusty_piano_coach.library.analyse import NO_PARTS, NOT_FOUND, UNREADABLE, AnalysisError, analyse_file
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.local import LocalSource

A1 = "local:a1"
B2 = "local:b2"


@pytest.fixture
def lib(tmp_path):
    library = Library(tmp_path / "data")
    library.upsert_catalogue([
        {"id": A1, "source": "local", "title": "Prelude", "composer": "100% Bach"},
        {"id": B2, "source": "local", "title": "Etude", "composer": "Chopin"},
    ])
    yield library
    library.close()


def ids(rows):
    return {r["id"] for r in rows}


def test_punctuation_only_search_matches_nothing(lib):
    assert ids(lib.search("!!!")) == set()


def test_whitespace_search_is_no_text_filter(lib):
    assert ids(lib.search("   ")) == {A1, B2}


def test_composer_percent_is_literal(lib):
    assert ids(lib.search(composer="%")) == {A1}


def test_composer_underscore_is_literal(lib):
    assert ids(lib.search(composer="_")) == set()


def test_composer_still_matches(lib):
    assert ids(lib.search(composer="bach")) == {A1}


def test_key_search_and_escaping(lib):
    lib.update_analysis(A1, file_path="files/local/a.musicxml", key="C major")
    lib.update_analysis(B2, file_path="files/local/b.musicxml", key="E minor")
    assert ids(lib.search(key="c major")) == {A1}
    assert ids(lib.search(key="C")) == {A1}
    assert ids(lib.search(key="_ major")) == set()
    assert ids(lib.search(key="%")) == set()


def test_analyse_not_music_hides_file_name(fixtures_dir):
    with pytest.raises(AnalysisError) as err:
        analyse_file(fixtures_dir / "not_music.xml")
    assert str(err.value) in (UNREADABLE, NO_PARTS)
    assert "not_music.xml" not in str(err.value)


def test_analyse_broken_file_is_unreadable(tmp_path):
    broken = tmp_path / "broken.musicxml"
    broken.write_text("<score-partwise><part", encoding="utf-8")
    with pytest.raises(AnalysisError) as err:
        analyse_file(broken)
    assert str(err.value) == UNREADABLE


def test_analyse_missing_file_is_not_found(tmp_path):
    with pytest.raises(AnalysisError) as err:
        analyse_file(tmp_path / "missing.musicxml")
    assert str(err.value) == NOT_FOUND


def test_skipped_line_shows_file_once(lib, fixtures_dir, capsys):
    LocalSource().import_paths(lib, [fixtures_dir / "not_music.xml"])
    out = capsys.readouterr().out
    lines = [line for line in out.splitlines() if line.startswith("skipped")]
    assert len(lines) == 1
    assert out.count("not_music.xml") == 1
    assert lines[0].endswith(UNREADABLE) or lines[0].endswith(NO_PARTS)
