import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import pytest

from rusty_piano_coach.cli import main
from rusty_piano_coach.library import score_notes
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.local import LocalSource
from rusty_piano_coach.library.score_notes import (
    empty_doc,
    hard_ranges,
    read_notes,
    sidecar_path,
    validate,
    write_notes,
)
from rusty_piano_coach.server import handle_request, safe_file

FIXTURES = Path(__file__).parent / "fixtures"
HEADERS = {"Host": "localhost:5173", "Origin": "http://localhost:5173", "Content-Type": "application/json"}
BODY = json.dumps({"piece_note": "p", "hard_bars": [3, 4], "bar_notes": {"4": "LH"}}).encode()
BARS = "hard_bars must be a list of bar numbers from 1 to 9999"
BAR_NOTES = "bar_notes must map bar numbers (1 to 9999) to text"


@pytest.fixture
def lib_dir(tmp_path):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    return d


def local_ids(d):
    with Library(d) as lib:
        rows = lib.search(None, downloaded=True, include_conflicts=True, limit=None)
    return [r["id"] for r in rows if r["source"] == "local"]


def score_path(d, sid=None):
    with Library(d) as lib:
        return safe_file(d, lib.get(sid or local_ids(d)[0]))


def notes_url(d, sid=None):
    return f"/api/scores/{quote(sid or local_ids(d)[0], safe='')}/notes"


def test_sidecar_path_naming():
    assert sidecar_path(Path("x.mxl")) == Path("x.mxl.notes.json")


def test_validate_normalises():
    doc = validate({
        "piece_note": "  Slow\r\nbreathe\r  ",
        "hard_bars": [10, 2, 2, 3],
        "bar_notes": {"10": " ten ", "2": "\r\nLH\r\n", "3": "   "},
        "version": 7,
        "updated_at": "later",
    })
    assert doc == {"piece_note": "Slow\nbreathe", "hard_bars": [2, 3, 10], "bar_notes": {"2": "LH", "10": "ten"}}
    assert list(doc["bar_notes"]) == ["2", "10"]


@pytest.mark.parametrize(
    "payload,message",
    [
        ({"hard_bars": [True]}, BARS),
        ({"hard_bars": [0]}, BARS),
        ({"hard_bars": [10000]}, BARS),
        ({"hard_bars": ["3"]}, BARS),
        ({"hard_bars": 3}, BARS),
        ({"bar_notes": {"0": "x"}}, BAR_NOTES),
        ({"bar_notes": {"x": "x"}}, BAR_NOTES),
        ({"bar_notes": {"3": 5}}, BAR_NOTES),
        ({"bar_notes": {"3": "a" * 501}}, "the note on bar 3 is longer than 500 characters"),
        ({"piece_note": "a" * 2001}, "the piece note is longer than 2000 characters"),
        ({"piece_note": 5}, "piece_note must be text"),
        ([], "notes must be a JSON object"),
    ],
)
def test_validate_errors(payload, message):
    with pytest.raises(ValueError) as e:
        validate(payload)
    assert str(e.value) == message


def test_hard_ranges():
    assert hard_ranges([9, 3, 4, 5]) == [[3, 5], [9, 9]]
    assert hard_ranges([]) == []


def test_round_trip(lib_dir):
    path = score_path(lib_dir)
    now = datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc)
    stored = write_notes(path, {"piece_note": "p", "hard_bars": [3, 4], "bar_notes": {"4": "LH"}}, now=now)
    assert stored["updated_at"] == "2026-11-15T10:00:00Z"
    raw = json.loads(sidecar_path(path).read_text(encoding="utf-8"))
    assert raw["version"] == 1
    assert read_notes(path) == stored


def test_empty_payload_removes_sidecar(lib_dir):
    path = score_path(lib_dir)
    write_notes(path, {"piece_note": "p"})
    assert sidecar_path(path).exists()
    assert write_notes(path, {}) == empty_doc()
    assert not sidecar_path(path).exists()


def test_missing_and_corrupt(lib_dir):
    path = score_path(lib_dir)
    assert read_notes(path) == empty_doc()
    sidecar_path(path).write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError):
        read_notes(path)


def test_get_empty(lib_dir):
    r = handle_request(lib_dir, notes_url(lib_dir), "GET")
    assert r.status == 200
    assert json.loads(r.body) == empty_doc()
    assert not list(lib_dir.rglob("*.notes.json"))


def test_post_then_get(lib_dir):
    r = handle_request(lib_dir, notes_url(lib_dir), "POST", HEADERS, body=BODY)
    assert r.status == 200
    stored = json.loads(r.body)
    assert stored["hard_bars"] == [3, 4]
    g = handle_request(lib_dir, notes_url(lib_dir), "GET", HEADERS)
    assert g.status == 200
    assert json.loads(g.body) == stored


def test_post_errors(lib_dir):
    url = notes_url(lib_dir)
    plain = {**HEADERS, "Content-Type": "text/plain"}
    r = handle_request(lib_dir, url, "POST", plain, body=BODY)
    assert r.status == 415
    assert json.loads(r.body)["error"] == "send the notes as application/json"
    r = handle_request(lib_dir, url, "POST", HEADERS, body=b"{nope")
    assert r.status == 400
    assert json.loads(r.body)["error"] == "notes are not valid JSON"
    long_note = json.dumps({"bar_notes": {"3": "a" * 501}}).encode()
    r = handle_request(lib_dir, url, "POST", HEADERS, body=long_note)
    assert r.status == 400
    assert json.loads(r.body)["error"] == "the note on bar 3 is longer than 500 characters"


def test_unknown_id(lib_dir):
    url = "/api/scores/local%3Azzzzzz/notes"
    assert handle_request(lib_dir, url, "GET").status == 404
    assert handle_request(lib_dir, url, "POST", HEADERS, body=BODY).status == 404


def test_evil_origin_refused(lib_dir):
    headers = {**HEADERS, "Origin": "http://evil.example"}
    r = handle_request(lib_dir, notes_url(lib_dir), "POST", headers, body=BODY)
    assert r.status == 403
    assert not sidecar_path(score_path(lib_dir)).exists()


def test_post_without_origin(lib_dir):
    headers = {"Host": "127.0.0.1:8765", "Content-Type": "application/json"}
    r = handle_request(lib_dir, notes_url(lib_dir), "POST", headers, body=BODY)
    assert r.status == 200


def test_corrupt_sidecar_untouched(lib_dir):
    path = score_path(lib_dir)
    raw = b'{"version": 1, "piece_note": '
    sidecar_path(path).write_bytes(raw)
    r = handle_request(lib_dir, notes_url(lib_dir), "GET")
    assert r.status == 500
    assert sidecar_path(path).read_bytes() == raw


def test_failed_replace_leaves_no_tmp(lib_dir, monkeypatch):
    path = score_path(lib_dir)

    def boom(*a, **k):
        raise PermissionError("locked")

    monkeypatch.setattr(score_notes.os, "replace", boom)
    with pytest.raises(PermissionError):
        write_notes(path, {"piece_note": "p"})
    assert not list(lib_dir.rglob("*.notes.json.tmp"))
    assert not sidecar_path(path).exists()


def test_remove_deletes_sidecar(lib_dir):
    sid = local_ids(lib_dir)[0]
    with Library(lib_dir) as lib:
        path = safe_file(lib_dir, lib.get(sid))
        write_notes(path, {"piece_note": "p"})
        LocalSource().remove(lib, sid)
        assert lib.get(sid) is None
    assert not path.exists()
    assert not sidecar_path(path).exists()


def test_remove_without_sidecar(lib_dir):
    sid = local_ids(lib_dir)[0]
    with Library(lib_dir) as lib:
        path = safe_file(lib_dir, lib.get(sid))
        LocalSource().remove(lib, sid)
        assert lib.get(sid) is None
    assert not path.exists()
