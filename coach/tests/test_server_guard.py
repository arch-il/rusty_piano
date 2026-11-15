import json

import pytest

from fake_pdmx import FAKE_IDS, build
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.pdmx import PdmxSource
from rusty_piano_coach.server import handle_request

DELETE = "/api/scores/pdmx%3Anope/delete"


@pytest.fixture(autouse=True)
def _no_env_ports(monkeypatch):
    monkeypatch.delenv("RUSTY_PIANO_ORIGIN_PORTS", raising=False)


def post(tmp_path, origin, host="127.0.0.1:8765", **kw):
    return handle_request(
        tmp_path / "lib", DELETE, "POST", {"Origin": origin, "Host": host}, Jobs(), **kw
    )


@pytest.mark.parametrize("path", ["/api/scores", "/api/jobs/current", "/api/scores/x/file"])
def test_get_refuses_evil_host(tmp_path, path):
    r = handle_request(tmp_path / "lib", path, "GET", {"Host": "evil.example:8765", "Origin": None})
    assert r.status == 403
    assert json.loads(r.body)["error"] == "cross-site request refused"


def test_get_refuses_missing_host(tmp_path):
    r = handle_request(tmp_path / "lib", "/api/scores", "GET", {"Host": None, "Origin": None})
    assert r.status == 403
    assert json.loads(r.body)["error"] == "cross-site request refused"


@pytest.mark.parametrize("host", ["127.0.0.1:8765", "localhost:5173", "[::1]:8765"])
def test_get_allows_local_hosts(tmp_path, host):
    r = handle_request(tmp_path / "lib", "/api/scores", "GET", {"Host": host, "Origin": None})
    assert r.status == 200


def test_get_without_headers_is_in_process(tmp_path):
    assert handle_request(tmp_path / "lib", "/api/scores").status == 200


@pytest.mark.parametrize(
    "origin,host",
    [
        ("http://localhost:5173", "127.0.0.1:8765"),
        ("http://localhost:4173", "127.0.0.1:8765"),
        ("http://127.0.0.1:8765", "127.0.0.1:8765"),
    ],
)
def test_post_allowed_origins(tmp_path, origin, host):
    assert post(tmp_path, origin, host).status == 404


@pytest.mark.parametrize(
    "origin", ["http://localhost:3000", "http://localhost", "http://localhost:8766", "http://localhost:99999"]
)
def test_post_refused_origins(tmp_path, origin):
    r = post(tmp_path, origin)
    assert r.status == 403
    body = json.loads(r.body)
    assert body["error"] == "cross-site request refused"
    assert "hint" in body


def test_post_custom_port(tmp_path):
    assert post(tmp_path, "http://localhost:8766", port=8766).status == 404


def test_post_evil_host_has_no_hint(tmp_path):
    r = post(tmp_path, None, "evil.example")
    assert r.status == 403
    assert "hint" not in json.loads(r.body)


def test_env_ports(tmp_path, monkeypatch):
    assert post(tmp_path, "http://localhost:5174").status == 403
    monkeypatch.setenv("RUSTY_PIANO_ORIGIN_PORTS", "bad, 5174")
    assert post(tmp_path, "http://localhost:5174").status == 404


def test_pdmx_download_quiet_with_progress(tmp_path, capsys):
    d = tmp_path / "lib"
    build(d)
    calls = []
    with Library(d) as lib:
        got = PdmxSource().download(
            lib, [FAKE_IDS["hymn"], FAKE_IDS["missing"]], progress=lambda *a: calls.append(a)
        )
        assert got == [FAKE_IDS["hymn"]]
        out = capsys.readouterr()
        assert out.out == "" and out.err == ""
        assert PdmxSource().download(lib, [FAKE_IDS["hymn"]], progress=lambda *a: calls.append(a)) == []
        out = capsys.readouterr()
        assert out.out == "" and out.err == ""
        PdmxSource().download(lib, [FAKE_IDS["hymn"]])
        assert "already downloaded" in capsys.readouterr().out
