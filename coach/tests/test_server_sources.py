import hashlib
import json
import shutil
import threading
from pathlib import Path

import pytest
from fake_pdmx import FAKE_IDS, build, fake_open_url, write_csv

from rusty_piano_coach.cli import main
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.library import fetch, pdmx
from rusty_piano_coach.library import sources
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.local import LocalSource
from rusty_piano_coach.library.pdmx import PdmxSource
from rusty_piano_coach.library.sources import SetupStep, Source
from rusty_piano_coach.server import handle_request, make_server

FIXTURES = Path(__file__).parent / "fixtures"

KEYS = {
    "id", "num", "title", "composer", "artist", "difficulty", "key", "time", "seconds",
    "piano_only", "source", "attribution", "license", "license_url", "format", "has_file", "file_url",
}

DOWNLOAD_HYMN = "/api/scores/pdmx%3AQmFakeAAAA/download"


@pytest.fixture(scope="module")
def lib_template(tmp_path_factory):
    d = tmp_path_factory.mktemp("tpl") / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    build(d)
    return d


@pytest.fixture(scope="module")
def noarchive_template(tmp_path_factory):
    d = tmp_path_factory.mktemp("tpl2") / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    build(d, archive=False)
    return d


@pytest.fixture(scope="module")
def plain_template(tmp_path_factory):
    d = tmp_path_factory.mktemp("tpl3") / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    return d


@pytest.fixture
def lib_dir(tmp_path, lib_template):
    return shutil.copytree(lib_template, tmp_path / "lib")


def get_json(d, path, jobs=None):
    r = handle_request(d, path, "GET", None, jobs)
    return r.status, json.loads(r.body)


def post(d, path, jobs, origin="http://localhost:5173", host="localhost:5173"):
    headers = {"Origin": origin, "Host": host}
    r = handle_request(d, path, "POST", headers, jobs)
    return r.status, json.loads(r.body)


def pdmx_rows(data):
    return [s for s in data["scores"] if s["source"] == "pdmx"]


def source_by_name(data, name):
    return next(s for s in data["sources"] if s["name"] == name)


def test_merged(lib_dir):
    status, data = get_json(lib_dir, "/api/scores?q=test", Jobs())
    assert status == 200
    scores = data["scores"]
    assert {s["title"] for s in scores[:2]} == {"Simple C Major", "Two Hands"}
    assert all(s["has_file"] for s in scores[:2])
    rest = scores[2:]
    assert {s["title"] for s in rest} == {"Hymn Test", "Duet Test", "Missing Test"}
    assert len(rest) == 3
    assert all(not s["has_file"] and s["source"] == "pdmx" for s in rest)
    assert "Conflict Test" not in {s["title"] for s in scores}
    ids = [s["id"] for s in scores]
    assert len(ids) == len(set(ids))
    for s in scores:
        assert set(s) == KEYS


def test_empty_and_short_queries(lib_dir):
    _, data = get_json(lib_dir, "/api/scores", Jobs())
    assert len(data["scores"]) == 2
    for q in ("t", "!!", "a!"):
        _, data = get_json(lib_dir, "/api/scores?q=" + q.replace("!", "%21"), Jobs())
        assert pdmx_rows(data) == []


def test_key_filter_still_lists_pdmx(lib_dir):
    _, data = get_json(lib_dir, "/api/scores?q=test&key=C%20major", Jobs())
    assert [s["title"] for s in data["scores"] if s["source"] == "local"] == ["Simple C Major"]
    assert len(pdmx_rows(data)) == 3


def test_sources(lib_dir):
    _, data = get_json(lib_dir, "/api/scores", Jobs())
    assert [s["name"] for s in data["sources"]] == ["local", "pdmx", "gen", "scales"]
    p = source_by_name(data, "pdmx")
    assert p["label"] == "PDMX"
    assert p["ready"] is True
    assert [st["id"] for st in p["steps"]] == ["catalogue", "archive"]


def test_download(lib_dir):
    jobs = Jobs()
    status, data = post(lib_dir, DOWNLOAD_HYMN, jobs)
    assert status == 202
    assert data["job"]["kind"] == "download"
    job = jobs.wait()
    assert job["state"] == "done"
    assert job["message"] == "Downloaded Hymn Test"
    _, data = get_json(lib_dir, "/api/scores?q=hymn", jobs)
    (row,) = data["scores"]
    assert row["id"] == FAKE_IDS["hymn"]
    assert row["has_file"] is True
    assert handle_request(lib_dir, row["file_url"]).status == 200
    _, data = get_json(lib_dir, "/api/scores", jobs)
    assert data["total"] == 3
    status, data = post(lib_dir, DOWNLOAD_HYMN, jobs)
    assert status == 409
    assert data["error"] == "already in your library"
    status, data = get_json(lib_dir, "/api/jobs/current", jobs)
    assert status == 200
    assert data["job"]["state"] == "done"


def test_download_missing_member(lib_dir):
    jobs = Jobs()
    path = "/api/scores/" + FAKE_IDS["missing"].replace(":", "%3A") + "/download"
    status, _ = post(lib_dir, path, jobs)
    assert status == 202
    job = jobs.wait()
    assert job["state"] == "error"
    assert job["error"] == "PDMX could not download this score (it is not in the archive or could not be read)."


def test_archive_not_set_up(tmp_path, noarchive_template):
    d = shutil.copytree(noarchive_template, tmp_path / "lib")
    status, data = post(d, DOWNLOAD_HYMN, Jobs())
    assert status == 409
    assert data["error"] == "Set up PDMX first: Score archive"


def test_unknown_and_wrong_method(lib_dir):
    status, _ = post(lib_dir, "/api/scores/pdmx%3Anope/download", Jobs())
    assert status == 404
    assert handle_request(lib_dir, DOWNLOAD_HYMN).status == 405
    assert handle_request(lib_dir, "/api/sources/pdmx/setup/catalogue").status == 405


def test_guard(lib_dir):
    jobs = Jobs()
    for origin, host in (
        ("http://evil.example", "localhost:5173"),
        ("null", "localhost:5173"),
        ("http://localhost:5173", "evil.example:8765"),
    ):
        status, data = post(lib_dir, DOWNLOAD_HYMN, jobs, origin=origin, host=host)
        assert status == 403
        assert data["error"] == "cross-site request refused"
    assert jobs.current() is None
    status, _ = post(lib_dir, DOWNLOAD_HYMN, jobs, origin=None, host="127.0.0.1:8765")
    assert status == 202
    jobs.wait()
    d2 = lib_dir
    status, _ = post(d2, "/api/scores/pdmx%3AQmFakeDDDD/download", jobs, origin="http://127.0.0.1:5173")
    assert status == 202
    jobs.wait()


def test_setup_catalogue(tmp_path, plain_template, monkeypatch):
    d = shutil.copytree(plain_template, tmp_path / "lib")
    jobs = Jobs()
    _, data = get_json(d, "/api/scores?q=hymn", jobs)
    assert pdmx_rows(data) == []
    p = source_by_name(data, "pdmx")
    assert p["ready"] is False
    assert [st["done"] for st in p["steps"]] == [False, False]

    csv_path = write_csv(tmp_path / "PDMX.csv")
    monkeypatch.setattr(fetch, "open_url", fake_open_url(csv_path.read_bytes()))
    monkeypatch.setattr(pdmx, "CSV_MD5", hashlib.md5(csv_path.read_bytes()).hexdigest())

    status, data = post(d, "/api/sources/pdmx/setup/catalogue", jobs)
    assert status == 202
    assert data["job"]["kind"] == "setup"
    assert data["job"]["target"] == "catalogue"
    job = jobs.wait()
    assert job["state"] == "done", job
    assert job["message"] == "Loaded 4 PDMX scores"
    _, data = get_json(d, "/api/scores?q=hymn", jobs)
    (row,) = data["scores"]
    assert row["title"] == "Hymn Test" and row["has_file"] is False
    assert source_by_name(data, "pdmx")["steps"][0]["done"] is True
    status, data = post(d, "/api/sources/pdmx/setup/catalogue", jobs)
    assert status == 409
    assert data["error"] == "already done"
    assert post(d, "/api/sources/nope/setup/x", jobs)[0] == 404
    assert post(d, "/api/sources/pdmx/setup/nope", jobs)[0] == 404


class DemoSource(Source):
    name = "demo"
    label = "Demo"

    def __init__(self, flag, event):
        self.flag = flag
        self.event = event

    def setup_steps(self, lib):
        return [SetupStep("prepare", "Prepare", "Demo step", "search", self.flag.exists())]

    def run_setup_step(self, lib, step_id, progress=None):
        self.event.wait(10)
        self.flag.write_text("x")
        return "Prepared"


class BrokenSearch(Source):
    name = "broken"

    def search(self, lib, text, **kw):
        raise RuntimeError("boom")


class BrokenSteps(Source):
    name = "brokensteps"

    def setup_steps(self, lib):
        raise RuntimeError("bad steps")


def test_busy_and_running_flag(tmp_path, lib_dir, monkeypatch):
    event = threading.Event()
    demo = DemoSource(tmp_path / "flag", event)
    monkeypatch.setattr(
        sources, "all_sources", lambda: {"local": LocalSource(), "pdmx": PdmxSource(), "demo": demo}
    )
    jobs = Jobs()
    try:
        status, _ = post(lib_dir, "/api/sources/demo/setup/prepare", jobs)
        assert status == 202
        _, data = get_json(lib_dir, "/api/scores?q=te", jobs)
        assert source_by_name(data, "demo")["steps"][0]["running"] is True
        status, data = post(lib_dir, DOWNLOAD_HYMN, jobs)
        assert status == 409
        assert "Another task is running" in data["error"]
    finally:
        event.set()
    jobs.wait()
    _, data = get_json(lib_dir, "/api/scores?q=te", jobs)
    assert source_by_name(data, "demo")["ready"] is True


def test_source_removed(lib_dir, monkeypatch):
    monkeypatch.setattr(sources, "all_sources", lambda: {"local": LocalSource()})
    _, data = get_json(lib_dir, "/api/scores?q=test", Jobs())
    assert pdmx_rows(data) == []
    assert [s["name"] for s in data["sources"]] == ["local"]


def test_search_error(lib_dir, monkeypatch):
    monkeypatch.setattr(
        sources, "all_sources", lambda: {"local": LocalSource(), "pdmx": PdmxSource(), "broken": BrokenSearch()}
    )
    status, data = get_json(lib_dir, "/api/scores?q=test", Jobs())
    assert status == 200
    assert source_by_name(data, "broken")["error"] == "search failed: boom"
    assert len(pdmx_rows(data)) == 3


def test_setup_steps_error(lib_dir, monkeypatch):
    monkeypatch.setattr(
        sources, "all_sources", lambda: {"local": LocalSource(), "brokensteps": BrokenSteps()}
    )
    status, data = get_json(lib_dir, "/api/scores?q=test", Jobs())
    assert status == 200
    b = source_by_name(data, "brokensteps")
    assert b["steps"] == [] and b["ready"] is False
    assert b["error"] == "setup check failed: bad steps"


def test_wal(lib_dir):
    with Library(lib_dir) as lib:
        assert lib.conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_reads_while_writer_holds_lock(lib_dir):
    w = Library(lib_dir)
    try:
        w.conn.execute("BEGIN IMMEDIATE")
        r = handle_request(lib_dir, "/api/scores?q=test")
        assert r.status == 200
        data = json.loads(r.body)
        assert any(s["source"] == "local" for s in data["scores"])
        assert len(pdmx_rows(data)) == 3
        local = next(s for s in data["scores"] if s["has_file"])
        assert handle_request(lib_dir, local["file_url"]).status == 200
    finally:
        w.conn.rollback()
        w.close()


def test_make_server_has_jobs(tmp_path):
    srv = make_server(tmp_path / "lib", 0)
    try:
        assert isinstance(srv.jobs, Jobs)
    finally:
        srv.server_close()
