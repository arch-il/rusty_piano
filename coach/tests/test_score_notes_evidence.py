import json
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from rusty_piano_coach import trends
from rusty_piano_coach.cli import main
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.score_notes import evidence_block, sidecar_path, write_notes
from rusty_piano_coach.server import safe_file

FIXTURES = Path(__file__).parent / "fixtures"
NOTES = {"piece_note": "Slow down in bar 9", "hard_bars": [9, 3, 4, 5], "bar_notes": {"4": "LH jump"}}
NOW = datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc)


@pytest.fixture
def lib_dir(tmp_path):
    d = tmp_path / "lib"
    assert main(["scores", "--data-dir", str(d), "import", str(FIXTURES)]) == 0
    return d


def local_ids(d):
    with Library(d) as lib:
        rows = lib.search(None, downloaded=True, include_conflicts=True, limit=None)
    return [r["id"] for r in rows if r["source"] == "local"]


def path_of(d, sid):
    with Library(d) as lib:
        return safe_file(d, lib.get(sid))


def expected(d, sid):
    with Library(d) as lib:
        title = lib.get(sid)["title"]
    return {
        sid: {
            "title": title,
            "piece_note": "Slow down in bar 9",
            "hard_bars": [3, 4, 5, 9],
            "hard_ranges": [[3, 5], [9, 9]],
            "bar_notes": {"4": "LH jump"},
            "updated_at": "2026-11-15T10:00:00Z",
        }
    }


def test_no_library_gives_empty(tmp_path):
    assert evidence_block(tmp_path / "none") == {}


def test_notes_on_one_score(lib_dir):
    sid, other = local_ids(lib_dir)[0], local_ids(lib_dir)[1]
    write_notes(path_of(lib_dir, sid), NOTES, now=NOW)
    assert evidence_block(lib_dir) == expected(lib_dir, sid)
    assert other not in evidence_block(lib_dir)


def test_corrupt_sidecar_is_skipped(lib_dir):
    sid, other = local_ids(lib_dir)[0], local_ids(lib_dir)[1]
    write_notes(path_of(lib_dir, sid), NOTES, now=NOW)
    sidecar_path(path_of(lib_dir, other)).write_text("{not json", encoding="utf-8")
    assert evidence_block(lib_dir) == expected(lib_dir, sid)


def test_build_evidence_includes_score_notes(lib_dir, tmp_path):
    sid = local_ids(lib_dir)[0]
    write_notes(path_of(lib_dir, sid), NOTES, now=NOW)
    ev = trends.build_evidence(
        attempts_dir=tmp_path / "attempts",
        reports_dir=tmp_path / "reports",
        plan_dir=tmp_path / "plan",
        scores_dir=lib_dir,
        since=None,
        today=date(2026, 11, 15),
        tz=timezone.utc,
        now=datetime(2026, 11, 15, 12, tzinfo=timezone.utc),
    )
    assert ev["score_notes"] == expected(lib_dir, sid)


def test_build_evidence_empty_scores_folder(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    ev = trends.build_evidence(
        attempts_dir=tmp_path / "attempts",
        reports_dir=tmp_path / "reports",
        plan_dir=tmp_path / "plan",
        scores_dir=empty,
        since=None,
        today=date(2026, 11, 15),
        tz=timezone.utc,
        now=datetime(2026, 11, 15, 12, tzinfo=timezone.utc),
    )
    assert ev["score_notes"] == {}


def test_cli_json_has_score_notes(lib_dir, tmp_path, capsys):
    sid = local_ids(lib_dir)[0]
    write_notes(path_of(lib_dir, sid), NOTES, now=NOW)
    args = [
        "evidence",
        "--json",
        "--all",
        "--data-dir",
        str(lib_dir),
        "--attempts-dir",
        str(tmp_path / "attempts"),
        "--reports-dir",
        str(tmp_path / "reports"),
        "--plan-dir",
        str(tmp_path / "plan"),
        "--sessions-dir",
        str(tmp_path / "sessions"),
    ]
    assert main(args) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["score_notes"][sid]["hard_ranges"] == [[3, 5], [9, 9]]
