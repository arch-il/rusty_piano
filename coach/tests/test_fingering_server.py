import json
import threading
from pathlib import Path
from urllib.parse import quote

import pytest

import rusty_piano_coach.library.fingering as fingering_module
from rusty_piano_coach.cli import main
from rusty_piano_coach.fingering_jobs import FingeringWorker
from rusty_piano_coach.library import scales
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.server import handle_request, safe_file

FIXTURES = Path(__file__).parent / "fixtures"
NOTES = [{"m": 0, "q": 0.0, "s": 0, "p": 60, "f": "1"}]
SCALE_ID = "scales:c-major-1oct-rh"


class Fake:
    def __init__(self):
        self.calls = 0

    def __call__(self, path):
        self.calls += 1
        return list(NOTES)


@pytest.fixture
def lib_dir(tmp_path):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    with Library(d) as lib:
        scales.generate(lib, keys={"c-major-1oct-rh"})
    return d


def local_ids(d):
    with Library(d) as lib:
        rows = lib.search(None, downloaded=True, include_conflicts=True, limit=None)
    return [r["id"] for r in rows if r["source"] == "local"]


def scale_sidecar(d):
    with Library(d) as lib:
        path = safe_file(d, lib.get(SCALE_ID))
    return fingering_module.sidecar_path(path)


def call(d, sid, method, worker, headers=None):
    r = handle_request(d, f"/api/scores/{quote(sid, safe='')}/fingering", method, headers, fingering=worker)
    return r.status, json.loads(r.body)


def test_get_is_read_only(lib_dir):
    fake = Fake()
    worker = FingeringWorker(runner=fake)
    status, body = call(lib_dir, local_ids(lib_dir)[0], "GET", worker)
    assert status == 200
    assert body == {"status": "none", "source": None, "notes": [], "error": None}
    assert fake.calls == 0


def test_post_runs_once(lib_dir):
    fake = Fake()
    worker = FingeringWorker(runner=fake)
    sid = local_ids(lib_dir)[0]
    status, body = call(lib_dir, sid, "POST", worker)
    assert status == 202 and body["status"] == "pending"
    assert worker.wait_idle(10)
    status, body = call(lib_dir, sid, "GET", worker)
    assert status == 200 and body["status"] == "ready"
    assert body["source"] == "pianoplayer"
    assert body["notes"] == NOTES
    status, body = call(lib_dir, sid, "POST", worker)
    assert status == 200 and body["status"] == "ready"
    assert fake.calls == 1


def test_pending_while_blocked(lib_dir):
    event = threading.Event()
    calls = []

    def blocking(path):
        calls.append(path)
        event.wait(10)
        return list(NOTES)

    worker = FingeringWorker(runner=blocking)
    sid = local_ids(lib_dir)[0]
    try:
        assert call(lib_dir, sid, "POST", worker)[0] == 202
        status, body = call(lib_dir, sid, "GET", worker)
        assert status == 200 and body["status"] == "pending"
        assert call(lib_dir, sid, "POST", worker)[0] == 202
    finally:
        event.set()
    assert worker.wait_idle(10)
    assert len(calls) == 1
    assert call(lib_dir, sid, "GET", worker)[1]["status"] == "ready"


def test_error_is_cached(lib_dir):
    calls = []

    def bad(path):
        calls.append(path)
        raise RuntimeError("bad")

    worker = FingeringWorker(runner=bad)
    sid = local_ids(lib_dir)[0]
    call(lib_dir, sid, "POST", worker)
    assert worker.wait_idle(10)
    status, body = call(lib_dir, sid, "GET", worker)
    assert body["status"] == "error" and body["error"] == "bad"
    status, body = call(lib_dir, sid, "POST", worker)
    assert status == 200 and body["status"] == "error"
    assert len(calls) == 1


def test_file_change_invalidates(lib_dir):
    worker = FingeringWorker(runner=Fake())
    sid = local_ids(lib_dir)[0]
    call(lib_dir, sid, "POST", worker)
    assert worker.wait_idle(10)
    assert call(lib_dir, sid, "GET", worker)[1]["status"] == "ready"
    with Library(lib_dir) as lib:
        path = safe_file(lib_dir, lib.get(sid))
    with open(path, "a", encoding="utf-8") as f:
        f.write("\n<!-- changed -->\n")
    assert call(lib_dir, sid, "GET", worker)[1]["status"] == "none"


def test_scales_answered_from_textbook(lib_dir):
    fake = Fake()
    worker = FingeringWorker(runner=fake)
    scale_sidecar(lib_dir).write_text("{}", encoding="utf-8")
    assert call(lib_dir, SCALE_ID, "GET", worker)[1]["status"] == "none"
    status, body = call(lib_dir, SCALE_ID, "POST", worker)
    assert status == 200 and body["status"] == "ready"
    assert body["source"] == "textbook"
    assert len(body["notes"]) == 15
    assert fake.calls == 0


def test_unknown_id_and_origin(lib_dir):
    worker = FingeringWorker(runner=Fake())
    assert call(lib_dir, "local:zzzzzz", "GET", worker)[0] == 404
    assert call(lib_dir, "local:zzzzzz", "POST", worker)[0] == 404
    sid = local_ids(lib_dir)[0]
    bad = {"Host": "127.0.0.1", "Origin": "http://localhost:9"}
    assert call(lib_dir, sid, "POST", worker, bad)[0] == 403


def test_cli(lib_dir, monkeypatch, capsys):
    fake = Fake()
    monkeypatch.setattr(fingering_module, "run_pianoplayer", fake)
    scale_sidecar(lib_dir).write_text("{}", encoding="utf-8")
    d = str(lib_dir)
    assert main(["fingering", "--data-dir", d]) == 0
    out = capsys.readouterr().out
    assert "generated (1 fingers" in out
    assert "textbook (15 fingers)" in out
    assert "Fingering: 3 made, 0 cached, 0 failed" in out
    assert fake.calls == 2
    assert main(["fingering", "--data-dir", d]) == 0
    assert "Fingering: 0 made, 3 cached, 0 failed" in capsys.readouterr().out
    assert main(["fingering", "--data-dir", d, "--force", "--source", "local"]) == 0
    assert "Fingering: 2 made, 0 cached, 0 failed" in capsys.readouterr().out
    assert fake.calls == 4
    sid = local_ids(lib_dir)[0]
    assert main(["fingering", "--data-dir", d, "--id", sid]) == 0
    out = capsys.readouterr().out
    assert sid in out and "Fingering: 0 made, 1 cached" in out
    assert main(["fingering", "--data-dir", d, "--id", "local:zzzzzz"]) == 1
    assert "error:" in capsys.readouterr().out
    assert main(["fingering", "--data-dir", d, "--source", "nope"]) == 1
    assert "error:" in capsys.readouterr().out

    def boom(path):
        raise RuntimeError("boom")

    monkeypatch.setattr(fingering_module, "run_pianoplayer", boom)
    assert main(["fingering", "--data-dir", d, "--force", "--source", "local"]) == 1
    assert "error: " in capsys.readouterr().out
