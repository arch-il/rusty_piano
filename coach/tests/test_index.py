import pytest

from rusty_piano_coach.library import paths
from rusty_piano_coach.library.index import Library

FUR = "pdmx:QmAAAA1111"
MINUET = "pdmx:QmAAAA2222"
ETUDE = "pdmx:QmBBBB3333"
CONFLICT = "pdmx:QmCCCC4444"
LOCAL = "local:abcdef0123456789"

RECORDS = [
    {"id": FUR, "source": "pdmx", "title": "Für Elise", "composer": "Beethoven",
     "difficulty": 2, "difficulty_basis": "catalogue", "seconds": 180, "piano_only": 1, "rating": 4.5},
    {"id": MINUET, "source": "pdmx", "title": "Minuet in G", "composer": "Bach",
     "difficulty": 1, "difficulty_basis": "catalogue", "seconds": 90, "piano_only": 1},
    {"id": ETUDE, "source": "pdmx", "title": "Hard Etude", "composer": "Chopin",
     "difficulty": 5, "difficulty_basis": "catalogue", "seconds": 300, "piano_only": 0},
    {"id": CONFLICT, "source": "pdmx", "title": "Conflict Song", "license_conflict": 1},
    {"id": LOCAL, "source": "local", "title": "My Tune"},
]


@pytest.fixture
def lib(tmp_path):
    library = Library(tmp_path)
    library.upsert_catalogue(RECORDS)
    yield library
    library.close()


def ids(rows):
    return {r["id"] for r in rows}


def test_search_text_and_diacritics(lib):
    assert ids(lib.search("fur")) == {FUR}
    assert ids(lib.search("eli")) == {FUR}


def test_composer_filter(lib):
    assert ids(lib.search(composer="bach")) == {MINUET}


def test_difficulty_filter(lib):
    assert ids(lib.search(difficulty=(1, 2))) == {FUR, MINUET}


def test_max_seconds_filter(lib):
    assert ids(lib.search(max_seconds=100)) == {MINUET}


def test_piano_filter(lib):
    assert ETUDE not in ids(lib.search(piano=True))


def test_license_conflicts_hidden_by_default(lib):
    assert CONFLICT not in ids(lib.search())
    assert CONFLICT in ids(lib.search(include_conflicts=True))


def test_source_filter(lib):
    assert ids(lib.search(source="local")) == {LOCAL}


def test_limit(lib):
    assert len(lib.search(limit=1)) == 1


def test_update_analysis_and_filters(lib):
    lib.update_analysis(MINUET, file_path="files/pdmx/x.mxl", key="G major", time_signature="3/4",
                        seconds=95, difficulty=3, piano_only=False)
    assert ids(lib.search(key="G")) == {MINUET}
    assert ids(lib.search(key="g major")) == {MINUET}
    assert MINUET not in ids(lib.search(key="G#"))
    assert ids(lib.search(time_signature="3/4")) == {MINUET}
    assert ids(lib.search(downloaded=True)) == {MINUET}
    row = lib.get(MINUET)
    assert row["seconds"] == 90
    assert row["piano_only"] == 1
    assert row["difficulty"] == 3
    assert row["difficulty_basis"] == "score"


def test_reupsert_keeps_num_analysis_and_score_difficulty(lib):
    lib.update_analysis(MINUET, file_path="files/pdmx/x.mxl", key="G major", time_signature="3/4",
                        seconds=95, difficulty=3, piano_only=False)
    num = lib.get(MINUET)["num"]
    lib.upsert_catalogue([
        {"id": MINUET, "source": "pdmx", "title": "Menuet in G", "composer": "Bach",
         "difficulty": 1, "difficulty_basis": "catalogue", "seconds": 90, "piano_only": 1},
    ])
    row = lib.get(MINUET)
    assert row["num"] == num
    assert row["file_path"] == "files/pdmx/x.mxl"
    assert row["key"] == "G major"
    assert row["time_signature"] == "3/4"
    assert row["difficulty"] == 3
    assert ids(lib.search("menuet")) == {MINUET}
    assert ids(lib.search("minuet")) == set()


def test_resolve(lib):
    num = lib.get(ETUDE)["num"]
    assert lib.resolve(ETUDE)["id"] == ETUDE
    assert lib.resolve(str(num))["id"] == ETUDE
    assert lib.resolve("#" + str(num))["id"] == ETUDE
    assert lib.resolve("pdmx:QmBBBB")["id"] == ETUDE
    with pytest.raises(LookupError):
        lib.resolve("pdmx:QmAAAA")
    with pytest.raises(LookupError):
        lib.resolve("nope")


def test_resolve_short_prefix_says_too_short(lib):
    with pytest.raises(LookupError, match="too short") as short:
        lib.resolve("pdmx:Qm")
    assert "4" in str(short.value)
    with pytest.raises(LookupError, match="too short"):
        lib.resolve("local:")
    with pytest.raises(LookupError, match="no score matches"):
        lib.resolve("pdmx:ZZZZZZZZ")


def test_order_title(lib):
    rows = lib.search(order="title", include_conflicts=True, limit=None)
    assert [r["title"] for r in rows] == ["Conflict Song", "Für Elise", "Hard Etude", "Minuet in G", "My Tune"]


def test_count(lib):
    assert lib.count() == 5


def test_paths(tmp_path, monkeypatch):
    monkeypatch.setenv(paths.DATA_DIR_ENV, str(tmp_path))
    assert paths.resolve_data_dir("X") == paths.Path("X").resolve()
    assert paths.resolve_data_dir() == tmp_path.resolve()
    monkeypatch.delenv(paths.DATA_DIR_ENV, raising=False)
    assert paths.resolve_data_dir() == paths.default_data_dir()
    assert (paths.default_data_dir() / "README.md").exists()
    files = paths.files_dir(tmp_path, "pdmx")
    assert files.is_dir()
