import shutil
from pathlib import Path

import pytest
from fake_pdmx import FAKE_IDS, build

from rusty_piano_coach.cli import main
from rusty_piano_coach.library.difficulty import catalogue_difficulty
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.local import LocalSource
from rusty_piano_coach.library.paths import remove_library_file
from rusty_piano_coach.library.pdmx import PdmxSource

FIXTURES = Path(__file__).parent / "fixtures"
HYMN = FAKE_IDS["hymn"]


@pytest.fixture(scope="module")
def template(tmp_path_factory):
    d = tmp_path_factory.mktemp("tpl") / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    build(d)
    with Library(d) as lib:
        assert PdmxSource().download(lib, [HYMN]) == [HYMN]
    return d


@pytest.fixture
def lib_dir(template, tmp_path):
    return Path(shutil.copytree(template, tmp_path / "lib"))


def local_id(lib, title):
    row = lib.conn.execute("SELECT id FROM scores WHERE title=?", (title,)).fetchone()
    return row["id"]


def test_pdmx_keeps_catalogue_row(lib_dir):
    with Library(lib_dir) as lib:
        before = lib.get(HYMN)
        PdmxSource().remove(lib, HYMN)
        after = lib.get(HYMN)
        assert not (lib_dir / "files" / "pdmx" / "QmFakeAAAA.mxl").exists()
        for k in ("file_path", "key", "time_signature", "downloaded_at"):
            assert after[k] is None
        assert catalogue_difficulty(1, 360, 41.4) == 2
        assert after["difficulty"] == 2
        assert after["difficulty_basis"] == "catalogue"
        for k in ("title", "composer", "license", "attribution", "source_ref", "rating", "num"):
            assert after[k] == before[k]
        assert [r["id"] for r in PdmxSource().search(lib, "hymn")] == [HYMN]


def test_pdmx_download_again(lib_dir):
    with Library(lib_dir) as lib:
        PdmxSource().remove(lib, HYMN)
        assert PdmxSource().download(lib, [HYMN]) == [HYMN]
        assert (lib_dir / "files" / "pdmx" / "QmFakeAAAA.mxl").exists()


def test_local_import_removed(tmp_path):
    mine = tmp_path / "mine"
    mine.mkdir()
    copy = mine / "piece.musicxml"
    shutil.copyfile(FIXTURES / "simple_c_major.musicxml", copy)
    with Library(tmp_path / "fresh") as lib:
        ids = LocalSource().import_paths(lib, [copy])
        sid = ids[0] if ids else local_id(lib, "Simple C Major")
        row = lib.get(sid)
        stored = lib.data_dir / row["file_path"]
        assert stored.exists()
        LocalSource().remove(lib, sid)
        assert lib.get(sid) is None
        assert not stored.exists()
        assert copy.exists()
        assert lib.search("simple") == []
        assert lib.count() == 0
        lib.conn.execute("INSERT INTO scores_fts(scores_fts) VALUES('integrity-check')")
        LocalSource().import_paths(lib, [copy])
        assert lib.get(sid) is not None


@pytest.mark.parametrize("bad", ["../outside.musicxml", "files"])
def test_refuses_outside_files(lib_dir, bad):
    outside = lib_dir.parent / "outside.musicxml"
    outside.write_text("x")
    with Library(lib_dir) as lib:
        sid = local_id(lib, "Simple C Major")
        lib.conn.execute("UPDATE scores SET file_path=? WHERE id=?", (bad, sid))
        lib.conn.commit()
        with pytest.raises(ValueError):
            LocalSource().remove(lib, sid)
        assert outside.exists()
        assert lib.get(sid) is not None


def test_missing_file_still_removes_row(lib_dir):
    with Library(lib_dir) as lib:
        sid = local_id(lib, "Simple C Major")
        (lib_dir / lib.get(sid)["file_path"]).unlink()
        LocalSource().remove(lib, sid)
        assert lib.get(sid) is None


def test_errors(lib_dir):
    with Library(lib_dir) as lib:
        with pytest.raises(LookupError):
            PdmxSource().remove(lib, "pdmx:nope")
        with pytest.raises(ValueError, match="This score is not in your library."):
            PdmxSource().remove(lib, FAKE_IDS["duet"])
        with pytest.raises(LookupError):
            LocalSource().remove(lib, HYMN)


def test_remove_library_file(tmp_path):
    f = tmp_path / "files" / "x" / "a.mxl"
    f.parent.mkdir(parents=True)
    f.write_text("x")
    assert remove_library_file(tmp_path, "files/x/a.mxl") is True
    assert remove_library_file(tmp_path, "files/x/a.mxl") is False


def test_cli(lib_dir, capsys):
    base = ["scores", "--data-dir", str(lib_dir)]
    assert main(base + ["delete", HYMN]) == 0
    out = capsys.readouterr().out
    assert "removed #" in out and "(still in PDMX search)" in out
    assert main(base + ["delete", HYMN]) == 0
    assert "not in your library:" in capsys.readouterr().out
    with Library(lib_dir) as lib:
        two = lib.conn.execute("SELECT id, num FROM scores WHERE title='Two Hands'").fetchone()
    assert main(base + ["delete", str(two["num"])]) == 0
    assert "removed #" in capsys.readouterr().out
    with Library(lib_dir) as lib:
        assert lib.get(two["id"]) is None
    assert main(base + ["delete", "nope:zzzz"]) == 1
    assert "error:" in capsys.readouterr().err
