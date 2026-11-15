import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from rusty_piano_coach import attempts, data_paths


def valid_attempt(**over):
    attempt = {
        "version": 1,
        "kind": "rusty_piano.attempt",
        "score": {"id": "local:abc", "title": "Two", "composer": None},
        "mode": "live",
        "end": "done",
        "started_at": "2026-11-05T07:00:00.000Z",
        "ended_at": "2026-11-05T07:00:03.000Z",
        "duration_ms": 3000,
        "clock": {"page_start_ms": 1000, "t0_ms": 2000, "first_engine_t": 500, "first_engine_page_ms": 2010},
        "practice": {
            "hands": "both",
            "range": None,
            "loop": False,
            "loops_completed": 0,
            "count_in_beats": 4,
            "beat_quarters": 1,
            "tempo": {"percent": 100, "scale": 1, "bpm": 120, "start_bpm": 120, "bpm_min": None, "bpm_max": None, "map": []},
        },
        "plan": {"steps_total": 1, "length_quarters": 1, "first_bar": 1, "last_bar": 1},
        "settings": {
            "window_ms": 200,
            "on_time_ms": 80,
            "holds": None,
            "follow_repeats": True,
            "follow_jumps": True,
            "repeats_after_jump": True,
            "follow_tempo_changes": True,
            "fallback_bpm": 120,
        },
        "autoplay": {
            "on_at_start": False,
            "used": False,
            "knobs": {
                "velocity": 80,
                "gate_percent": 90,
                "wait_lead_ms": 0,
                "offset_ms": 0,
                "jitter_ms": 0,
                "skip_every": 0,
                "wrong_every": 0,
                "short_every": 0,
                "seed": 1,
            },
        },
        "sources": ["engine"],
        "pedal_down_at_start": False,
        "steps": [
            {
                "cycle": 1,
                "step": 0,
                "source_step": 0,
                "bar": 1,
                "beat": 0,
                "pass": 1,
                "time_q": 0,
                "expected": [60],
                "result": "hit",
                "outcome": "hit",
                "offset_ms": 10,
                "played": [{"note": 60, "offset_ms": 10, "page_ms": 2010}],
                "wrong": [],
                "holds": [],
            }
        ],
        "events": [{"type": "note_on", "t": 500, "page_ms": 2010, "source": "engine", "note": 60, "velocity": 100}],
        "summary": {"counts": {}, "metrics": {}, "rows": []},
    }
    attempt.update(over)
    return attempt


@pytest.mark.parametrize(
    "obj, message",
    [
        ([], "attempt must be a JSON object"),
        (valid_attempt(version=3), "unsupported attempt version (expected 1 or 2)"),
        (valid_attempt(kind="other"), "attempt kind must be rusty_piano.attempt"),
        (valid_attempt(score={"id": ""}), "score.id must be a non-empty string"),
        (valid_attempt(score={"id": "x" * 501}), "score.id must be a non-empty string"),
        (valid_attempt(score=None), "score.id must be a non-empty string"),
        (valid_attempt(mode="stop"), "mode must be wait or live"),
        (valid_attempt(end="finished"), "end must be done, stop or interrupted"),
        (valid_attempt(started_at="yesterday"), "started_at must be an ISO date-time"),
        (valid_attempt(started_at=5), "started_at must be an ISO date-time"),
        (valid_attempt(steps="x"), "steps must be a list"),
        (valid_attempt(events="x"), "events must be a list"),
        (valid_attempt(events=[{"type": "note_on", "source": "engine"}] * 500_001), "too many events (limit 500000)"),
        (valid_attempt(events=[{"type": "click", "source": "engine"}]), "event 0: unknown type"),
        (valid_attempt(events=[{"type": "note_on", "source": "mic"}]), "event 0: unknown source"),
        (valid_attempt(summary=[]), "summary must be an object"),
    ],
)
def test_validation_messages(obj, message):
    with pytest.raises(ValueError) as info:
        attempts.validate_attempt(obj)
    assert str(info.value) == message


def test_valid_attempt_passes_validation():
    attempts.validate_attempt(valid_attempt())


def v2_attempt(**over):
    attempt = valid_attempt(version=2, drill_id="r2.steps", plan_id=None, tags=["fun"])
    attempt.update(over)
    return attempt


def test_valid_v2_saves_with_version_2_and_keeps_the_drill_fields(tmp_path):
    stored = attempts.save_attempt(tmp_path, v2_attempt(), now=datetime(2026, 11, 5, 7, 0, 0, tzinfo=timezone.utc))
    assert stored["version"] == 2
    assert stored["drill_id"] == "r2.steps"
    assert stored["plan_id"] is None
    assert stored["tags"] == ["fun"]
    written = json.loads((tmp_path / f"{stored['id']}.json").read_text(encoding="utf-8"))
    assert written["version"] == 2
    assert written["tags"] == ["fun"]


@pytest.mark.parametrize(
    "obj, message",
    [
        ({k: v for k, v in v2_attempt().items() if k != "tags"}, "tags must be a list of short lowercase words"),
        (v2_attempt(tags=["Fun!"]), "tags must be a list of short lowercase words"),
        (v2_attempt(tags=["a"] * 11), "tags must be a list of short lowercase words"),
        (v2_attempt(tags=["x" * 21]), "tags must be a list of short lowercase words"),
        (v2_attempt(drill_id=5), "drill_id must be null or a short string"),
        (v2_attempt(drill_id="x" * 101), "drill_id must be null or a short string"),
        (v2_attempt(plan_id="x" * 41), "plan_id must be null or a short string"),
    ],
)
def test_v2_drill_field_messages(obj, message):
    with pytest.raises(ValueError) as info:
        attempts.validate_attempt(obj)
    assert str(info.value) == message


def test_v1_still_validates_and_is_stored_as_version_1(tmp_path):
    attempts.validate_attempt(valid_attempt())
    stored = attempts.save_attempt(tmp_path, valid_attempt(), now=datetime(2026, 11, 5, 7, 0, 0, tzinfo=timezone.utc))
    assert stored["version"] == 1
    assert "tags" not in stored


def test_attempt_drill_reads_v1_and_v2():
    assert attempts.attempt_drill(valid_attempt()) == (None, None, ())
    assert attempts.attempt_drill(v2_attempt()) == ("r2.steps", None, ("fun",))
    assert attempts.attempt_drill(valid_attempt(version=2)) == (None, None, ())


def test_save_writes_id_and_saved_at_after_version(tmp_path):
    folder = tmp_path / "attempts"
    now = datetime(2026, 11, 5, 7, 0, 3, 900000, tzinfo=timezone.utc)
    stored = attempts.save_attempt(folder, valid_attempt(), now=now)
    assert re.fullmatch(attempts.ID_RE, stored["id"])
    assert stored["id"].startswith("attempt-20261105-070003-")
    assert stored["saved_at"] == "2026-11-05T07:00:03Z"
    original = valid_attempt()
    assert list(stored) == ["version", "id", "saved_at"] + [k for k in original if k != "version"]
    written = json.loads((folder / f"{stored['id']}.json").read_text(encoding="utf-8"))
    assert written == stored
    assert list(folder.glob("*.tmp")) == []


def test_same_second_ids_get_a_suffix(tmp_path, monkeypatch):
    monkeypatch.setattr(attempts.secrets, "token_hex", lambda n: "aaaaaa")
    now = datetime(2026, 11, 5, 7, 0, 3, tzinfo=timezone.utc)
    first = attempts.save_attempt(tmp_path, valid_attempt(), now=now)
    second = attempts.save_attempt(tmp_path, valid_attempt(), now=now)
    assert first["id"] == "attempt-20261105-070003-aaaaaa"
    assert second["id"] == "attempt-20261105-070003-aaaaaa-2"
    assert re.fullmatch(attempts.ID_RE, second["id"])


def test_list_skips_broken_and_wrong_version_files(tmp_path):
    attempts.save_attempt(tmp_path, valid_attempt(), now=datetime(2026, 11, 5, 7, 0, 0, tzinfo=timezone.utc))
    (tmp_path / "attempt-broken.json").write_text("{", encoding="utf-8")
    (tmp_path / "attempt-v3.json").write_text(json.dumps({"version": 3}), encoding="utf-8")
    kept, problems = attempts.list_attempts(tmp_path)
    assert len(kept) == 1
    assert kept[0]["version"] == 1
    assert any(p.startswith("attempt-broken.json: unreadable (") for p in problems)
    assert "attempt-v3.json: not a version 1 or 2 attempt" in problems


def test_list_missing_folder_is_empty(tmp_path):
    assert attempts.list_attempts(tmp_path / "nope") == ([], [])


def test_load_by_id_prefix_latest_path_and_errors(tmp_path):
    older = attempts.save_attempt(
        tmp_path, valid_attempt(score={"id": "local:old", "title": "Old", "composer": None}),
        now=datetime(2026, 11, 5, 7, 0, 0, tzinfo=timezone.utc),
    )
    newer = attempts.save_attempt(
        tmp_path, valid_attempt(score={"id": "local:new", "title": "New", "composer": None}),
        now=datetime(2026, 11, 5, 7, 1, 0, tzinfo=timezone.utc),
    )
    assert attempts.load_attempt(tmp_path, older["id"])["id"] == older["id"]
    assert attempts.load_attempt(tmp_path, "attempt-20261105-0701")["id"] == newer["id"]
    assert attempts.load_attempt(tmp_path, "latest")["id"] == newer["id"]
    assert attempts.load_attempt(tmp_path, str(tmp_path / f"{older['id']}.json"))["id"] == older["id"]
    with pytest.raises(LookupError, match="matches 2 attempts"):
        attempts.load_attempt(tmp_path, "attempt-20261105-07")
    with pytest.raises(LookupError, match="no attempt matches"):
        attempts.load_attempt(tmp_path, "attempt-20991231")


def test_latest_with_no_attempts_is_lookup_error(tmp_path):
    with pytest.raises(LookupError, match="no attempts saved yet"):
        attempts.load_attempt(tmp_path, "latest")


def test_attempts_dir_is_under_the_data_dir_env(tmp_path):
    folder = data_paths.attempts_dir()
    assert folder == Path(os.environ["RUSTY_PIANO_DATA_DIR"]).resolve() / "attempts"
    assert folder.is_relative_to(tmp_path.resolve())
    assert not folder.exists()
