import shutil
import sqlite3
from pathlib import Path

import pytest
from fake_pdmx import FAKE_IDS, build

import rusty_piano_coach.library.sources as sources_module
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.local import LocalSource
from rusty_piano_coach.library.paths import library_file
from rusty_piano_coach.library.pdmx import PdmxSource

FIXTURES = Path(__file__).parent / "fixtures"
HYMN = FAKE_IDS["hymn"]


@pytest.fixture(scope="module")
def template(tmp_path_factory):
    d = tmp_path_factory.mktemp("tpl") / "lib"
    with Library(d) as lib:
        LocalSource().import_paths(lib, [FIXTURES])
    build(d)
    with Library(d) as lib:
        PdmxSource().download(lib, [HYMN])
    return d


@pytest.fixture
def lib_dir(template, tmp_path):
    return Path(shutil.copytree(template, tmp_path / "lib"))


def local_id(lib):
    return lib.conn.execute("SELECT id FROM scores WHERE title='Simple C Major'").fetchone()["id"]


def no_removing(d):
    return not list((d / "files").rglob("*.removing"))


def boom(*args, **kwargs):
    raise sqlite3.OperationalError("disk I/O error")


def test_pdmx_index_failure_restores_file(lib_dir, monkeypatch):
    with Library(lib_dir) as lib:
        before = lib.get(HYMN)["file_path"]
        monkeypatch.setattr(lib, "clear_download", boom)
        with pytest.raises(sqlite3.OperationalError):
            PdmxSource().remove(lib, HYMN)
        assert (lib_dir / "files" / "pdmx" / "QmFakeAAAA.mxl").exists()
        assert lib.get(HYMN)["file_path"] == before
        assert no_removing(lib_dir)


def test_local_index_failure_restores_file(lib_dir, monkeypatch):
    with Library(lib_dir) as lib:
        sid = local_id(lib)
        full = lib_dir / lib.get(sid)["file_path"]
        monkeypatch.setattr(lib, "remove_score", boom)
        with pytest.raises(sqlite3.OperationalError):
            LocalSource().remove(lib, sid)
        assert full.is_file()
        assert lib.get(sid) is not None
        assert no_removing(lib_dir)


def test_rename_failure_changes_nothing(lib_dir, monkeypatch):
    def locked(*args, **kwargs):
        raise PermissionError("locked")

    with Library(lib_dir) as lib:
        before = lib.get(HYMN)["file_path"]
        monkeypatch.setattr(sources_module.os, "replace", locked)
        with pytest.raises(PermissionError):
            PdmxSource().remove(lib, HYMN)
        assert (lib_dir / "files" / "pdmx" / "QmFakeAAAA.mxl").exists()
        assert lib.get(HYMN)["file_path"] == before


def test_success_leaves_no_removing_file(lib_dir):
    with Library(lib_dir) as lib:
        sid = local_id(lib)
        full = lib_dir / lib.get(sid)["file_path"]
        PdmxSource().remove(lib, HYMN)
        LocalSource().remove(lib, sid)
        assert not full.exists()
        assert not (lib_dir / "files" / "pdmx" / "QmFakeAAAA.mxl").exists()
        assert no_removing(lib_dir)


def test_library_file(tmp_path):
    with pytest.raises(ValueError):
        library_file(tmp_path, "../x.mxl")
    full = library_file(tmp_path, "files/x/a.mxl")
    assert full.is_relative_to((tmp_path / "files").resolve())
