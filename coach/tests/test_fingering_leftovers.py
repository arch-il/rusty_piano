import json
import os
import shutil
import time
import xml.etree.ElementTree as ET

import rusty_piano_coach.library.fingering as fingering
from rusty_piano_coach.cli import main
from rusty_piano_coach.fingering_jobs import FingeringWorker
from rusty_piano_coach.library.fingering import generate, score_notes, sidecar_path, write_sidecar
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.server import safe_file
from test_fingering import MARKS, _Runner
from test_fingering_server import Fake, call, lib_dir, local_ids  # noqa: F401

DAY = 86400


def _root(body):
    return ET.fromstring(
        f'<score-partwise version="3.1"><part id="P1"><measure number="1">{body}</measure></part></score-partwise>'
    )


def _n(step, octave, dur, staff=None, attrs=""):
    st = f"<staff>{staff}</staff>" if staff else ""
    return (
        f"<note{attrs}><pitch><step>{step}</step><octave>{octave}</octave></pitch>"
        f"<duration>{dur}</duration>{st}</note>"
    )


def test_decimal_duration():
    root = _root(
        "<attributes><divisions>2</divisions></attributes>"
        + _n("C", 4, "1.5") + _n("D", 4, "2.5") + _n("E", 4, "1")
    )
    assert [(n["p"], n["q"]) for n in score_notes(root)] == [(60, 0.0), (62, 0.75), (64, 2.0)]


def test_decimal_backup_forward():
    root = _root(
        "<attributes><divisions>4</divisions><staves>2</staves></attributes>"
        + _n("C", 4, 4, 1)
        + "<backup><duration>4.0</duration></backup>"
        + "<forward><duration>2.5</duration></forward>"
        + _n("E", 3, 2, 2)
    )
    e = [n for n in score_notes(root) if n["p"] == 52][0]
    assert e["q"] == 0.625 and e["s"] == 1


def test_garbage_duration():
    root = _root(_n("C", 4, "abc") + _n("D", 4, 1))
    assert [n["q"] for n in score_notes(root)] == [0.0, 0.0]


def test_invisible_note_skipped():
    root = _root(
        "<attributes><divisions>1</divisions></attributes>"
        + _n("C", 4, 1) + _n("D", 4, 1, attrs=' print-object="no"') + _n("E", 4, 1)
    )
    assert [(n["p"], n["q"]) for n in score_notes(root)] == [(60, 0.0), (64, 2.0)]


def _score(tmp_path):
    p = tmp_path / "s.musicxml"
    shutil.copyfile(MARKS, p)
    return p


def _json(score):
    return json.loads(sidecar_path(score).read_text(encoding="utf-8"))


def _rewrite(score, **changes):
    obj = _json(score)
    obj.update(changes)
    for k in [k for k, v in changes.items() if v is None]:
        del obj[k]
    sidecar_path(score).write_text(json.dumps(obj), encoding="utf-8")


def _fail(score, tool=None):
    write_sidecar(score, source="pianoplayer", tool=tool or fingering.pianoplayer_tool(), notes=[], error="old")


def test_failed_at_only_on_errors(tmp_path):
    s = _score(tmp_path)
    _fail(s)
    assert isinstance(_json(s)["failed_at"], int)
    write_sidecar(s, source="pianoplayer", tool="x", notes=[])
    assert "failed_at" not in _json(s)


def test_version_retry(tmp_path, monkeypatch):
    s = _score(tmp_path)
    _fail(s, "pianoplayer 0.0.1")
    monkeypatch.setattr(fingering, "pianoplayer_tool", lambda: "pianoplayer 9.9")
    r = _Runner()
    assert generate(s, runner=r)["status"] == "ready"
    assert r.calls == 1


def test_fresh_error_not_retried(tmp_path):
    s = _score(tmp_path)
    _fail(s)
    r = _Runner()
    assert generate(s, runner=r)["status"] == "error"
    assert r.calls == 0


def test_age(tmp_path):
    s = _score(tmp_path)
    _fail(s)
    _rewrite(s, failed_at=time.time() - 6 * DAY)
    r = _Runner()
    generate(s, runner=r)
    assert r.calls == 0
    _rewrite(s, failed_at=time.time() - 8 * DAY)
    generate(s, runner=r)
    assert r.calls == 1


def test_mtime_fallback(tmp_path):
    s = _score(tmp_path)
    _fail(s)
    _rewrite(s, failed_at=None)
    t = time.time() - 8 * DAY
    os.utime(sidecar_path(s), (t, t))
    r = _Runner()
    generate(s, runner=r)
    assert r.calls == 1
    _fail(s)
    _rewrite(s, failed_at=None)
    t = time.time()
    os.utime(sidecar_path(s), (t, t))
    generate(s, runner=r)
    assert r.calls == 1


def _lib_score(d, sid):
    with Library(d) as lib:
        return safe_file(d, lib.get(sid))


def test_server_post_retry(lib_dir):
    sid = local_ids(lib_dir)[0]
    path = _lib_score(lib_dir, sid)
    fake = Fake()
    worker = FingeringWorker(runner=fake)
    _fail(path, "pianoplayer 0.0.1")
    status, body = call(lib_dir, sid, "POST", worker)
    assert status == 202
    assert worker.wait_idle(10)
    status, body = call(lib_dir, sid, "GET", worker)
    assert body["status"] == "ready"
    assert fake.calls == 1


def test_server_post_fresh_error(lib_dir):
    sid = local_ids(lib_dir)[0]
    path = _lib_score(lib_dir, sid)
    fake = Fake()
    worker = FingeringWorker(runner=fake)
    _fail(path)
    status, body = call(lib_dir, sid, "POST", worker)
    assert status == 200 and body["status"] == "error"
    assert fake.calls == 0


def test_cli_retry(lib_dir, monkeypatch, capsys):
    sid = local_ids(lib_dir)[0]
    path = _lib_score(lib_dir, sid)
    fake = Fake()
    monkeypatch.setattr(fingering, "run_pianoplayer", fake)
    _fail(path, "pianoplayer 0.0.1")
    main(["fingering", "--data-dir", str(lib_dir), "--id", sid])
    assert "generated" in capsys.readouterr().out
    assert fake.calls == 1
    _fail(path)
    main(["fingering", "--data-dir", str(lib_dir), "--id", sid])
    assert "cached error" in capsys.readouterr().out
    assert fake.calls == 1
