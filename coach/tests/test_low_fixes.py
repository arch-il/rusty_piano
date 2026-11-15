from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pytest
from evidence_fixtures import make_attempt, write_attempts

from rusty_piano_coach import attempt_cache, localzone
from rusty_piano_coach.localzone import LOCAL

UTC = timezone.utc


def test_dst_fold_round_trips(monkeypatch):
    try:
        berlin = ZoneInfo("Europe/Berlin")
    except ZoneInfoNotFoundError:
        pytest.skip("Europe/Berlin is not available")

    def offset_at(ts):
        return datetime.fromtimestamp(ts, berlin).utcoffset()

    monkeypatch.setattr(localzone, "_offset_at", offset_at)
    first = datetime(2026, 10, 25, 0, 30, tzinfo=UTC)
    second = datetime(2026, 10, 25, 1, 30, tzinfo=UTC)
    a = first.astimezone(LOCAL)
    b = second.astimezone(LOCAL)
    assert a.replace(tzinfo=None) == b.replace(tzinfo=None) == datetime(2026, 10, 25, 2, 30)
    assert a.astimezone(UTC) == first
    assert b.astimezone(UTC) == second
    assert a.utcoffset() == timedelta(hours=2)
    assert b.utcoffset() == timedelta(hours=1)


def test_cache_entry_with_garbage_attempt_is_reread(tmp_path):
    a = make_attempt(id="attempt-20261101-100000-aaaaa1")
    write_attempts(tmp_path, [a])
    first, _ = attempt_cache.read_attempts(tmp_path)
    cache_file = tmp_path / ".cache" / "attempts-v2.marshal"
    files = attempt_cache._load_cache(cache_file)
    files[f"{a['id']}.json"]["attempt"] = {"x": 1}
    attempt_cache._write_cache(cache_file, files)
    again, _ = attempt_cache.read_attempts(tmp_path)
    assert [x["id"] for x in again] == [a["id"]]
