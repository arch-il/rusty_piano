import os
import time
from pathlib import Path
from urllib.parse import quote

from test_fingering_server import Fake, lib_dir, local_ids  # noqa: F401

import rusty_piano_coach.library.fingering as fingering_module
import rusty_piano_coach.server as server
from rusty_piano_coach.cli import main
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.library import fingering
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.server import handle_request, safe_file

FIXTURES = Path(__file__).parent / "fixtures"
HEADERS = {"Origin": "http://localhost:5173", "Host": "localhost:5173"}


def write_sidecar_for(d, sid):
    with Library(d) as lib:
        path = safe_file(d, lib.get(sid))
    fingering.write_sidecar(path, source="pianoplayer", tool="t", notes=[])
    tmp = fingering.sidecar_path(path).with_name(fingering.sidecar_path(path).name + ".tmp")
    tmp.write_text("partial", encoding="utf-8")
    return path, fingering.sidecar_path(path), tmp


def test_remove_sidecar(tmp_path):
    score = tmp_path / "piece.musicxml"
    score.write_text("x", encoding="utf-8")
    side = fingering.sidecar_path(score)
    side.write_text("{}", encoding="utf-8")
    tmp = side.with_name(side.name + ".tmp")
    tmp.write_text("{}", encoding="utf-8")
    assert fingering.remove_sidecar(score) == 2
    assert not side.exists() and not tmp.exists()
    assert fingering.remove_sidecar(score) == 0


def test_sweep(tmp_path):
    d = tmp_path / "lib"
    local = d / "files" / "local"
    local.mkdir(parents=True)
    (local / "a.musicxml").write_text("x", encoding="utf-8")
    (local / "a.musicxml.fingering.json").write_text("{}", encoding="utf-8")
    (local / "ghost.musicxml.fingering.json").write_text("{}", encoding="utf-8")
    (local / "parked.musicxml.removing").write_text("x", encoding="utf-8")
    (local / "parked.musicxml.fingering.json").write_text("{}", encoding="utf-8")
    old = local / "x.musicxml.fingering.json.tmp"
    old.write_text("partial", encoding="utf-8")
    past = time.time() - 7200
    os.utime(old, (past, past))
    fresh = local / "y.musicxml.fingering.json.tmp"
    fresh.write_text("partial", encoding="utf-8")
    other = d / "other"
    other.mkdir()
    (other / "z.musicxml.fingering.json").write_text("{}", encoding="utf-8")

    assert fingering.sweep_sidecars(d) == (1, 1)
    assert (local / "a.musicxml.fingering.json").exists()
    assert not (local / "ghost.musicxml.fingering.json").exists()
    assert (local / "parked.musicxml.fingering.json").exists()
    assert not old.exists()
    assert fresh.exists()
    assert (other / "z.musicxml.fingering.json").exists()


def test_sweep_missing_files_dir(tmp_path):
    assert fingering.sweep_sidecars(tmp_path / "nothing") == (0, 0)


def test_remove_cli_cleans_sidecar(tmp_path):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    sid = local_ids(d)[0]
    path, side, tmp = write_sidecar_for(d, sid)
    assert main(["scores", "--data-dir", str(d), "delete", sid]) == 0
    assert not side.exists() and not tmp.exists()


def test_remove_server_cleans_sidecar(tmp_path):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    sid = local_ids(d)[0]
    path, side, tmp = write_sidecar_for(d, sid)
    r = handle_request(d, f"/api/scores/{quote(sid, safe='')}/delete", "POST", HEADERS, Jobs())
    assert r.status == 200
    assert not side.exists() and not tmp.exists()


def test_cli_fingering_sweeps(lib_dir, monkeypatch, capsys):
    ghost = lib_dir / "files" / "local" / "ghost.musicxml.fingering.json"
    ghost.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(fingering_module, "run_pianoplayer", Fake())
    assert main(["fingering", "--data-dir", str(lib_dir), "--source", "local"]) == 0
    assert not ghost.exists()
    assert "Cleaned up 1 leftover fingering file(s)" in capsys.readouterr().out


class FakeServer:
    server_address = ("127.0.0.1", 0)

    def __init__(self, tmp_path):
        self.attempts_dir = tmp_path
        self.plan_dir = tmp_path
        self.sessions_dir = tmp_path

    def serve_forever(self):
        raise KeyboardInterrupt

    def server_close(self):
        pass


def test_serve_sweeps(lib_dir, tmp_path, monkeypatch):
    ghost = lib_dir / "files" / "local" / "ghost.musicxml.fingering.json"
    ghost.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(server, "make_server", lambda *a, **k: FakeServer(tmp_path))
    assert server.serve(lib_dir) == 0
    assert not ghost.exists()
