import marshal

from evidence_fixtures import make_attempt, write_attempts
from test_ear import ear_attempt
from test_sight import sight_attempt

from rusty_piano_coach import attempt_cache, runs


def two(folder):
    a1 = make_attempt(id="attempt-20261101-100000-aaaaa1", started_at="2026-11-01T10:00:00+00:00")
    a2 = make_attempt(id="attempt-20261102-100000-aaaaa2", started_at="2026-11-02T10:00:00+00:00")
    write_attempts(folder, [a1, a2])


def cache_file(folder):
    return folder / ".cache" / attempt_cache.CACHE_FILE


def test_old_v1_files_are_deleted(tmp_path):
    two(tmp_path)
    cache = tmp_path / ".cache"
    cache.mkdir()
    (cache / "attempts-v1.json").write_text("{}", encoding="utf-8")
    (cache / "attempts-v1.json.tmp").write_text("{}", encoding="utf-8")
    runs.load_attempts(tmp_path)
    assert cache_file(tmp_path).name == "attempts-v2.marshal"
    assert cache_file(tmp_path).exists()
    assert not (cache / "attempts-v1.json").exists()
    assert not (cache / "attempts-v1.json.tmp").exists()


def test_other_python_version_rebuilds(tmp_path, monkeypatch):
    two(tmp_path)
    runs.load_attempts(tmp_path)
    files = attempt_cache._load_cache(cache_file(tmp_path))
    cache_file(tmp_path).write_bytes(marshal.dumps({"version": 2, "python": "0.0", "files": files}))
    real = attempt_cache._read_json
    calls = []

    def counting(path):
        calls.append(path)
        return real(path)

    monkeypatch.setattr(attempt_cache, "_read_json", counting)
    runs.load_attempts(tmp_path)
    assert len(calls) == 2


def test_corrupt_bytes_are_rebuilt(tmp_path):
    two(tmp_path)
    runs.load_attempts(tmp_path)
    cache_file(tmp_path).write_bytes(b"\x00garbage\xff")
    kept, _ = runs.load_attempts(tmp_path)
    assert len(kept) == 2


def test_played_kept_only_for_scale_scores():
    piece = attempt_cache.slim(make_attempt(score="piece-a"))
    assert all("played" not in s for s in piece["steps"])
    scale = attempt_cache.slim(make_attempt(score="scales:c-major-1oct-rh"))
    assert all(s["played"] == [{"note": 60, "page_ms": 0}] for s in scale["steps"])


def test_warm_equals_cold_for_a_mix(tmp_path):
    write_attempts(
        tmp_path,
        [
            make_attempt(id="attempt-20261101-100000-piece1", score="piece-a"),
            make_attempt(id="attempt-20261101-110000-scale1", score="scales:c-major-1oct-rh"),
            sight_attempt(),
            ear_attempt("attempt-20261101-120000-ear001", "2026-11-01T12:00:00+00:00"),
        ],
    )
    first = attempt_cache.read_attempts(tmp_path)[0]
    second = attempt_cache.read_attempts(tmp_path)[0]
    assert len(first) == 4
    assert first == second
