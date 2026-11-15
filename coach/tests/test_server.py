import json
import shutil
from pathlib import Path
from urllib.parse import quote

import pytest

from rusty_piano_coach import server
from rusty_piano_coach.cli import main
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.server import handle_request, make_server

FIXTURES = Path(__file__).parent / "fixtures"

KEYS = {
    "id", "num", "title", "composer", "artist", "difficulty", "key", "time", "seconds",
    "piano_only", "source", "attribution", "license", "license_url", "format", "has_file", "file_url",
}


@pytest.fixture(scope="module")
def lib_template(tmp_path_factory):
    d = tmp_path_factory.mktemp("tpl") / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    return d


@pytest.fixture
def lib_dir(tmp_path, lib_template):
    return shutil.copytree(lib_template, tmp_path / "lib")


def get(d, path):
    return handle_request(d, path)


def get_json(d, path):
    r = handle_request(d, path)
    return r.status, json.loads(r.body)


def titles(data):
    return {s["title"] for s in data["scores"]}


def test_list_scores(lib_dir):
    r = get(lib_dir, "/api/scores")
    assert r.status == 200
    assert r.content_type == "application/json; charset=utf-8"
    data = json.loads(r.body)
    assert data["total"] == 2
    assert titles(data) == {"Simple C Major", "Two Hands"}
    for s in data["scores"]:
        assert set(s) == KEYS
        assert s["format"] == "musicxml"
        assert s["file_url"].startswith("/api/scores/local%3A")
        assert s["file_url"].endswith("/file")
    assert data["facets"] == {
        "keys": ["C major", "E minor"],
        "times": ["3/4", "4/4"],
        "difficulties": [1, 2],
    }


def test_search_text(lib_dir):
    _, data = get_json(lib_dir, "/api/scores?q=two")
    assert titles(data) == {"Two Hands"}


def test_filters(lib_dir):
    _, data = get_json(lib_dir, "/api/scores?difficulty=1")
    assert titles(data) == {"Simple C Major"}
    _, data = get_json(lib_dir, "/api/scores?key=E%20minor")
    assert titles(data) == {"Two Hands"}
    _, data = get_json(lib_dir, "/api/scores?key=E+minor")
    assert titles(data) == {"Two Hands"}
    _, data = get_json(lib_dir, "/api/scores?time=4%2F4")
    assert titles(data) == {"Simple C Major"}


def test_bad_parameters(lib_dir):
    status, data = get_json(lib_dir, "/api/scores?difficulty=9")
    assert status == 400 and "error" in data
    status, data = get_json(lib_dir, "/api/scores?limit=abc")
    assert status == 400 and "error" in data


def test_detail(lib_dir):
    _, data = get_json(lib_dir, "/api/scores")
    for s in data["scores"]:
        status, detail = get_json(lib_dir, "/api/scores/" + quote(s["id"], safe=""))
        assert status == 200
        assert detail["title"] == s["title"]
    assert get(lib_dir, "/api/scores/local%3Anope").status == 404


def test_file(lib_dir):
    _, data = get_json(lib_dir, "/api/scores?q=two")
    (s,) = data["scores"]
    r = get(lib_dir, s["file_url"])
    assert r.status == 200
    assert r.content_type == "application/vnd.recordare.musicxml+xml"
    with Library(lib_dir) as lib:
        file_path = lib.get(s["id"])["file_path"]
    assert r.body == (lib_dir / file_path).read_bytes()


def test_mxl(tmp_path, fixtures_dir, make_mxl):
    src = make_mxl(fixtures_dir / "simple_c_major.musicxml", tmp_path / "c.mxl")
    d = tmp_path / "mxl_lib"
    assert main(["scores", "--data-dir", str(d), "import", str(src)]) == 0
    _, data = get_json(d, "/api/scores")
    (s,) = data["scores"]
    assert s["format"] == "mxl"
    r = get(d, s["file_url"])
    assert r.status == 200
    assert r.content_type == "application/vnd.recordare.musicxml"
    assert r.body.startswith(b"PK")


def test_catalogue_only_row_is_hidden(lib_dir):
    with Library(lib_dir) as lib:
        lib.upsert_catalogue([{"id": "x:1", "source": "x", "title": "Cat Only", "license_conflict": 0}])
    _, data = get_json(lib_dir, "/api/scores")
    assert "Cat Only" not in titles(data)
    assert get(lib_dir, "/api/scores/x%3A1").status == 404
    assert get(lib_dir, "/api/scores/x%3A1/file").status == 404


def test_unsafe_file_paths(lib_dir, fixtures_dir):
    (lib_dir.parent / "outside.musicxml").write_bytes(b"<score-partwise/>")
    _, data = get_json(lib_dir, "/api/scores?q=two")
    (s,) = data["scores"]
    with Library(lib_dir) as lib:
        lib.conn.execute("UPDATE scores SET file_path=? WHERE id=?", ("../outside.musicxml", s["id"]))
        lib.conn.commit()
    assert get_json(lib_dir, "/api/scores")[1]["total"] == 1
    assert get(lib_dir, s["file_url"]).status == 404
    with Library(lib_dir) as lib:
        lib.conn.execute("UPDATE scores SET file_path=? WHERE id=?", (str(fixtures_dir / "two_hands_e_minor.musicxml"), s["id"]))
        lib.conn.commit()
    assert get(lib_dir, s["file_url"]).status == 404
    assert get(lib_dir, "/api/scores/..%2F..%2Fpyproject.toml/file").status == 404
    assert get(lib_dir, "/api/../pyproject.toml").status == 404


def test_unknown_routes(lib_dir):
    assert get(lib_dir, "/").status == 404
    assert get(lib_dir, "/api/nope").status == 404
    assert get(lib_dir, "/api/scores/x/file/extra").status == 404


def test_empty_library(tmp_path):
    status, data = get_json(tmp_path / "empty", "/api/scores")
    assert status == 200
    assert data["scores"] == []
    assert data["total"] == 0
    assert data["facets"] == {"keys": [], "times": [], "difficulties": []}
    assert [s["name"] for s in data["sources"]] == ["local", "pdmx", "gen", "scales"]


def test_make_server_binds_loopback(tmp_path):
    srv = make_server(tmp_path / "lib", 0)
    try:
        assert srv.server_address[0] == "127.0.0.1"
        assert srv.server_address[1] > 0
    finally:
        srv.server_close()


def test_serve_command(tmp_path, monkeypatch):
    calls = []

    def fake_serve(data_dir, port, attempts_dir=None):
        calls.append((data_dir, port))
        return 0

    monkeypatch.setattr(server, "serve", fake_serve)
    d = tmp_path / "lib"
    assert main(["serve", "--data-dir", str(d), "--port", "9001"]) == 0
    assert calls[-1] == (d.resolve(), 9001)
    assert main(["serve", "--data-dir", str(d)]) == 0
    assert calls[-1] == (d.resolve(), 8765)
