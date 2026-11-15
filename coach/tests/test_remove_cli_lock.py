import threading

import pytest

from fake_pdmx import FAKE_IDS, build
from rusty_piano_coach.cli import main
from rusty_piano_coach.jobs import Busy, Jobs
from rusty_piano_coach.library.busy import FileLock, busy_lock
from rusty_piano_coach.server import make_server

HYMN = FAKE_IDS["hymn"]


def run(capsys, d, *args):
    code = main(["scores", "--data-dir", str(d), *args])
    return code, capsys.readouterr()


@pytest.fixture
def lib_dir(tmp_path, fixtures_dir, capsys):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(fixtures_dir)]) == 0
    build(d)
    assert main(["scores", "--data-dir", str(d), "download", HYMN]) == 0
    capsys.readouterr()
    return d


def test_delete_processes_all_ids(lib_dir, capsys):
    code, cap = run(capsys, lib_dir, "delete", "nope", HYMN, "#99999")
    assert code == 1
    assert "nope" in cap.err and "99999" in cap.err and "2 of 3" in cap.err
    assert "removed #" in cap.out
    assert not (lib_dir / "files" / "pdmx" / "QmFakeAAAA.mxl").exists()


def test_delete_not_in_library_is_not_failure(tmp_path, capsys):
    d = tmp_path / "lib"
    build(d)
    code, cap = run(capsys, d, "delete", HYMN)
    assert code == 0
    assert "not in your library" in cap.out


def test_delete_refused_while_job_runs(lib_dir, capsys):
    jobs = Jobs(lock_path=lib_dir / "busy.lock")
    ev = threading.Event()
    jobs.start(kind="download", source="pdmx", target="x", label="Download X", work=lambda p: ev.wait(10))
    try:
        code, cap = run(capsys, lib_dir, "delete", HYMN)
        assert code == 1
        assert "another coach process is using this library" in cap.err
        assert (lib_dir / "files" / "pdmx" / "QmFakeAAAA.mxl").exists()
    finally:
        ev.set()
        jobs.wait()
    assert run(capsys, lib_dir, "delete", HYMN)[0] == 0


def test_job_refused_while_cli_holds_lock(tmp_path):
    d = tmp_path / "lib"
    d.mkdir()
    lock = busy_lock(d)
    assert lock.acquire()
    jobs = Jobs(lock_path=d / "busy.lock")
    with pytest.raises(Busy) as e:
        jobs.start(kind="download", source="pdmx", target="x", label="X", work=lambda p: None)
    assert "a coach command in another window" in str(e.value)
    lock.release()
    jobs.start(kind="download", source="pdmx", target="x", label="X", work=lambda p: None)
    assert jobs.wait()["state"] == "done"


def test_file_lock_exclusive(tmp_path):
    p = tmp_path / "x" / "busy.lock"
    a, b = FileLock(p), FileLock(p)
    assert a.acquire() is True
    assert b.acquire() is False
    a.release()
    assert b.acquire() is True
    b.release()


def test_make_server_uses_lock_path(tmp_path):
    srv = make_server(tmp_path / "lib2", 0)
    try:
        assert srv.jobs.lock_path == tmp_path / "lib2" / "busy.lock"
    finally:
        srv.server_close()
