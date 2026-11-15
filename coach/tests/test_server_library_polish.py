import json
from pathlib import Path
from urllib.parse import quote

import pytest

from rusty_piano_coach import plan
from rusty_piano_coach.cli import main
from rusty_piano_coach.jobs import Busy, Jobs
from rusty_piano_coach.library import sources
from rusty_piano_coach.library.busy import FileLock, busy_lock
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.server import handle_request

FIXTURES = Path(__file__).parent / "fixtures"
OTHER = "a coach command in another window"


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


def make_lib(tmp_path):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    return d


def test_idle_refuses_while_another_process_holds_the_lock(tmp_path):
    d = tmp_path / "lib"
    d.mkdir()
    lock = busy_lock(d)
    assert lock.acquire()
    jobs = Jobs(lock_path=d / "busy.lock")
    with pytest.raises(Busy, match=OTHER):
        with jobs.idle():
            pass
    lock.release()
    with jobs.idle():
        pass
    again = FileLock(d / "busy.lock")
    assert again.acquire() is True
    again.release()


def test_page_delete_while_cli_holds_the_lock_is_409(tmp_path):
    d = make_lib(tmp_path)
    sid = simple_id(d)
    with Library(d) as lib:
        file = d / lib.get(sid)["file_path"]
    route = "/api/scores/" + quote(sid, safe="") + "/delete"
    jobs = Jobs(lock_path=d / "busy.lock")
    lock = busy_lock(d)
    assert lock.acquire()
    status, data = post(d, route, jobs)
    assert status == 409
    assert OTHER in data["error"]
    assert file.exists()
    lock.release()
    status, _ = post(d, route, jobs)
    assert status == 200


def test_sweep_restores_and_discards(tmp_path):
    d = make_lib(tmp_path)
    orphan = d / "files" / "local" / "zzz.musicxml.removing"
    orphan.parent.mkdir(parents=True, exist_ok=True)
    orphan.write_text("x")
    with Library(d) as lib:
        row = lib.conn.execute("SELECT file_path FROM scores WHERE file_path IS NOT NULL").fetchone()
        real = d / row["file_path"]
        parked = real.with_name(real.name + ".removing")
        real.rename(parked)
        assert sources.sweep_removing(lib) == (1, 1)
    assert real.exists()
    assert not parked.exists()
    assert not orphan.exists()


def test_remove_sweeps_first(tmp_path, capsys):
    d = make_lib(tmp_path)
    orphan = d / "files" / "local" / "zzz.musicxml.removing"
    orphan.parent.mkdir(parents=True, exist_ok=True)
    orphan.write_text("x")
    sid = simple_id(d)
    assert main(["scores", "--data-dir", str(d), "delete", sid]) == 0
    assert not orphan.exists()


@pytest.mark.parametrize(
    "name,url,expected",
    [
        (None, None, "License: -"),
        ("CC0", None, "License: CC0"),
        (None, "https://x.example/l", "License: https://x.example/l"),
        ("CC-BY", "https://y.example/l", "License: CC-BY (https://y.example/l)"),
    ],
)
def test_show_licence_line(tmp_path, capsys, name, url, expected):
    d = make_lib(tmp_path)
    sid = simple_id(d)
    with Library(d) as lib:
        lib.conn.execute("UPDATE scores SET license=?, license_url=? WHERE id=?", (name, url, sid))
        lib.conn.commit()
    capsys.readouterr()
    assert main(["scores", "--data-dir", str(d), "show", sid]) == 0
    assert expected in capsys.readouterr().out.splitlines()


def test_plan_problems_are_not_duplicated(tmp_path):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / plan.TREE_FILE).write_text(json.dumps(plan.load_json(plan.SEED_TREE)))
    (plan_dir / plan.STATE_FILE).write_text("not json")
    r = handle_request(tmp_path / "lib", "/api/plan", "GET", {"Host": "127.0.0.1:8765"}, Jobs(), plan_dir=plan_dir)
    assert r.status == 200
    problems = json.loads(r.body)["problems"]
    assert len(problems) == len(set(problems))
    assert sum("state.json is not valid JSON" in p for p in problems) == 1
