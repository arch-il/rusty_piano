import json
import shutil
import threading
from pathlib import Path
from urllib.parse import quote

import pytest
from fake_pdmx import FAKE_IDS, build

from rusty_piano_coach.cli import main
from rusty_piano_coach.jobs import Busy, Jobs
from rusty_piano_coach.library import sources
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.local import LocalSource
from rusty_piano_coach.library.pdmx import PdmxSource
from rusty_piano_coach.server import handle_request

FIXTURES = Path(__file__).parent / "fixtures"
HYMN = FAKE_IDS["hymn"]
REMOVE_HYMN = "/api/scores/pdmx%3AQmFakeAAAA/delete"
HYMN_FILE = "files/pdmx/QmFakeAAAA.mxl"
NOT_IN_LIBRARY = "This score is not in your library."


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


def get_json(d, path, jobs=None):
    r = handle_request(d, path, "GET", None, jobs)
    return r.status, json.loads(r.body)


def post(d, path, jobs, origin="http://localhost:5173", host="localhost:5173"):
    headers = {"Origin": origin, "Host": host}
    r = handle_request(d, path, "POST", headers, jobs)
    return r.status, json.loads(r.body)


def simple_id(d):
    _, data = get_json(d, "/api/scores")
    return next(s["id"] for s in data["scores"] if s["title"] == "Simple C Major")


def test_remove_pdmx(lib_dir):
    jobs = Jobs()
    status, data = post(lib_dir, REMOVE_HYMN, jobs)
    assert status == 200
    assert data == {"removed": HYMN, "kept_in_catalogue": True, "message": "Removed Hymn Test"}
    assert not (lib_dir / HYMN_FILE).exists()
    _, data = get_json(lib_dir, "/api/scores")
    assert data["total"] == 2
    assert HYMN not in {s["id"] for s in data["scores"]}
    _, data = get_json(lib_dir, "/api/scores?q=hymn")
    (row,) = data["scores"]
    assert row["has_file"] is False
    assert row["source"] == "pdmx"
    assert row["difficulty"] == 2
    assert handle_request(lib_dir, "/api/scores/pdmx%3AQmFakeAAAA").status == 404
    assert handle_request(lib_dir, "/api/scores/pdmx%3AQmFakeAAAA/file").status == 404
    status, data = post(lib_dir, REMOVE_HYMN, jobs)
    assert status == 409
    assert data["error"] == NOT_IN_LIBRARY


def test_remove_then_download(lib_dir):
    jobs = Jobs()
    assert post(lib_dir, REMOVE_HYMN, jobs)[0] == 200
    status, _ = post(lib_dir, "/api/scores/pdmx%3AQmFakeAAAA/download", jobs)
    assert status == 202
    assert jobs.wait()["state"] == "done"
    _, data = get_json(lib_dir, "/api/scores?q=hymn", jobs)
    (row,) = data["scores"]
    assert row["has_file"] is True


def test_remove_local(lib_dir):
    sid = simple_id(lib_dir)
    status, data = post(lib_dir, f"/api/scores/{quote(sid, safe='')}/delete", Jobs())
    assert status == 200
    assert data["kept_in_catalogue"] is False
    assert data["message"] == "Removed Simple C Major"
    _, data = get_json(lib_dir, "/api/scores")
    assert data["total"] == 2
    _, data = get_json(lib_dir, "/api/scores?q=simple")
    assert data["scores"] == []
    assert (FIXTURES / "simple_c_major.musicxml").exists()
    with Library(lib_dir) as lib:
        lib.conn.execute("INSERT INTO scores_fts(scores_fts) VALUES('integrity-check')")


def test_busy(lib_dir):
    jobs = Jobs()
    event = threading.Event()
    jobs.start(kind="setup", source="demo", target="x", label="Blocker", work=lambda progress: event.wait(10))
    try:
        status, data = post(lib_dir, REMOVE_HYMN, jobs)
        assert status == 409
        assert data["error"] == "Another task is running: Blocker. Wait for it to finish."
        assert (lib_dir / HYMN_FILE).exists()
    finally:
        event.set()
        jobs.wait()
    assert post(lib_dir, REMOVE_HYMN, jobs)[0] == 200


@pytest.mark.parametrize(
    "origin,host",
    [
        ("http://evil.example", "localhost:5173"),
        ("null", "localhost:5173"),
        ("http://localhost:5173", "evil.example:8765"),
    ],
)
def test_guard(lib_dir, origin, host):
    status, data = post(lib_dir, REMOVE_HYMN, Jobs(), origin=origin, host=host)
    assert status == 403
    assert data["error"] == "cross-site request refused"
    assert (lib_dir / HYMN_FILE).exists()


def test_guard_no_origin(lib_dir):
    assert post(lib_dir, REMOVE_HYMN, Jobs(), origin=None, host="127.0.0.1:8766")[0] == 200


def test_get_and_unknown(lib_dir):
    jobs = Jobs()
    assert handle_request(lib_dir, REMOVE_HYMN, "GET", None, jobs).status == 405
    status, _ = post(lib_dir, "/api/scores/pdmx%3Anope/delete", jobs)
    assert status == 404
    status, data = post(lib_dir, "/api/scores/pdmx%3AQmFakeDDDD/delete", jobs)
    assert status == 409
    assert data["error"] == NOT_IN_LIBRARY


def test_outside_files(lib_dir):
    sid = simple_id(lib_dir)
    with Library(lib_dir) as lib:
        lib.conn.execute("UPDATE scores SET file_path = ? WHERE id = ?", ("../outside.musicxml", sid))
        lib.conn.commit()
    outside = lib_dir / "outside.musicxml"
    outside.write_text("x")
    status, data = post(lib_dir, f"/api/scores/{quote(sid, safe='')}/delete", Jobs())
    assert status == 409
    assert "The score file is outside the library files folder, so it was not removed." in data["error"]
    assert outside.exists()
    with Library(lib_dir) as lib:
        assert lib.get(sid) is not None


def test_unknown_source(lib_dir, monkeypatch):
    monkeypatch.setattr(sources, "all_sources", lambda: {"local": LocalSource()})
    status, data = post(lib_dir, REMOVE_HYMN, Jobs())
    assert status == 404
    assert data["error"] == "unknown source"
    assert (lib_dir / HYMN_FILE).exists()


def test_remove_oserror(lib_dir, monkeypatch):
    def boom(*a, **k):
        raise PermissionError("locked")

    monkeypatch.setattr(sources.os, "replace", boom)
    status, data = post(lib_dir, REMOVE_HYMN, Jobs())
    assert status == 500
    assert data["error"].startswith("Could not remove the score file:")
    assert (lib_dir / HYMN_FILE).exists()
    with Library(lib_dir) as lib:
        assert lib.get(HYMN)["file_path"]


def test_jobs_idle():
    jobs = Jobs()
    with jobs.idle():
        pass
    event = threading.Event()
    jobs.start(kind="setup", source="demo", target="x", label="Blocker", work=lambda progress: event.wait(10))
    try:
        with pytest.raises(Busy):
            with jobs.idle():
                pass
    finally:
        event.set()
        jobs.wait()
    with jobs.idle():
        pass
