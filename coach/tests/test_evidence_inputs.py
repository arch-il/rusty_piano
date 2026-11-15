import json
import os
from datetime import timezone

from evidence_fixtures import make_attempt, make_steps, note_on, write_attempts
from test_runs_ramp import ramped_attempt

from rusty_piano_coach import attempt_cache, attempts, runs

SUFFIX = "empty (stopped before any note was due)"


def two(folder):
    a1 = make_attempt(id="attempt-20261101-100000-aaaaa1")
    a2 = make_attempt(id="attempt-20261102-100000-aaaaa2", started_at="2026-11-02T10:00:00+00:00")
    write_attempts(folder, [a1, a2])
    return a1, a2


def cache_path(folder):
    return folder / ".cache" / "attempts-v1.json"


def test_empty_attempts_are_skipped(tmp_path):
    normal = make_attempt(id="attempt-20261101-100000-aaaaa1")
    none = make_attempt(id="attempt-20261102-100000-aaaaa2", steps=[], started_at="2026-11-02T10:00:00+00:00")
    pend = make_attempt(
        id="attempt-20261103-100000-aaaaa3",
        steps=make_steps(["pending"] * 4),
        started_at="2026-11-03T10:00:00+00:00",
    )
    write_attempts(tmp_path, [normal, none, pend])
    kept, skipped = runs.load_attempts(tmp_path)
    assert [a["id"] for a in kept] == [normal["id"]]
    assert len(skipped) == 2
    assert all(s.endswith(SUFFIX) for s in skipped)
    assert len(runs.load_runs(kept, timezone.utc)) == 1


def test_cache_file_is_written_and_reused(tmp_path, monkeypatch):
    two(tmp_path)
    first, _ = runs.load_attempts(tmp_path)
    assert cache_path(tmp_path).exists()

    def boom(path):
        raise AssertionError("read")

    monkeypatch.setattr(attempt_cache, "_read_json", boom)
    second, _ = runs.load_attempts(tmp_path)
    assert [a["id"] for a in second] == [a["id"] for a in first]
    assert second == first


def test_changed_file_is_read_again(tmp_path, monkeypatch):
    a1, a2 = two(tmp_path)
    runs.load_attempts(tmp_path)
    path = tmp_path / f"{a1['id']}.json"
    t = path.stat().st_mtime_ns + 2_000_000_000
    changed = make_attempt(id=a1["id"], title="Other")
    path.write_text(json.dumps(changed), encoding="utf-8")
    os.utime(path, ns=(t, t))
    calls = []
    real = attempt_cache._read_json

    def counting(p):
        calls.append(p)
        return real(p)

    monkeypatch.setattr(attempt_cache, "_read_json", counting)
    kept, _ = runs.load_attempts(tmp_path)
    assert len(calls) == 1
    assert [a["score"]["title"] for a in kept if a["id"] == a1["id"]] == ["Other"]


def test_removed_file_leaves_the_cache(tmp_path):
    a1, a2 = two(tmp_path)
    runs.load_attempts(tmp_path)
    (tmp_path / f"{a1['id']}.json").unlink()
    kept, _ = runs.load_attempts(tmp_path)
    assert len(kept) == 1
    data = json.loads(cache_path(tmp_path).read_text(encoding="utf-8"))
    assert len(data["files"]) == 1


def test_corrupt_cache_is_rebuilt(tmp_path):
    two(tmp_path)
    runs.load_attempts(tmp_path)
    cache_path(tmp_path).write_text("garbage", encoding="utf-8")
    kept, _ = runs.load_attempts(tmp_path)
    assert len(kept) == 2
    assert json.loads(cache_path(tmp_path).read_text(encoding="utf-8"))["version"] == 1


def test_slim_attempt_keeps_velocities(tmp_path):
    write_attempts(tmp_path, [make_attempt(events=[note_on(40), note_on(90)])])
    kept, _ = runs.load_attempts(tmp_path)
    assert "events" not in kept[0]
    assert runs.engine_velocities(kept[0]) == [40, 90]


def test_same_problems_as_list_attempts(tmp_path):
    two(tmp_path)
    (tmp_path / "attempt-broken.json").write_text("{", encoding="utf-8")
    (tmp_path / "attempt-v3.json").write_text(json.dumps({"version": 3}), encoding="utf-8")
    cached = attempt_cache.read_attempts(tmp_path)[1]
    assert cached == attempts.list_attempts(tmp_path)[1]
    assert cache_path(tmp_path).exists()
    assert not any(".cache" in p or "attempts-v1" in p for p in attempts.list_attempts(tmp_path)[1])


def test_missing_folder(tmp_path):
    folder = tmp_path / "nope"
    assert attempt_cache.read_attempts(folder) == ([], [])
    assert not folder.exists()


def test_ramped_percents_survive_the_cache(tmp_path):
    a = ramped_attempt([{"cycle": 1, "percent": 60}, {"cycle": 2, "percent": 65}, {"cycle": 3, "percent": 70}])
    write_attempts(tmp_path, [a])
    for _ in range(2):
        kept, _ = runs.load_attempts(tmp_path)
        assert [r.tempo_percent for r in runs.load_runs(kept, timezone.utc)] == [60, 65, 70]


def test_bad_cache_entry_does_not_crash(tmp_path):
    a1, a2 = two(tmp_path)
    runs.load_attempts(tmp_path)
    data = json.loads(cache_path(tmp_path).read_text(encoding="utf-8"))
    data["files"][f"{a1['id']}.json"] = "x"
    cache_path(tmp_path).write_text(json.dumps(data), encoding="utf-8")
    kept, _ = runs.load_attempts(tmp_path)
    assert len(kept) == 2
