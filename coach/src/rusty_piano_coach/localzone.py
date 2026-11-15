"""The computer's own time zone with its daylight-saving rules, asked from the OS for each instant.

datetime.now().astimezone().tzinfo is a fixed offset (today's), so dates and local midnights in another season can be an hour off; LOCAL follows the OS rules without extra packages.
"""

import time
from datetime import datetime, timedelta, timezone, tzinfo

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _offset_at(ts: float) -> timedelta:
    try:
        return timedelta(seconds=time.localtime(ts).tm_gmtoff)
    except (OverflowError, OSError, ValueError):
        return timedelta(seconds=time.localtime().tm_gmtoff)


class SystemLocal(tzinfo):
    def utcoffset(self, dt):
        if dt is None:
            return _offset_at(time.time())
        try:
            wall = (dt.replace(tzinfo=timezone.utc, fold=0) - _EPOCH).total_seconds()
        except OverflowError:
            return _offset_at(time.time())
        before = _offset_at(wall - 86400)
        after = _offset_at(wall + 86400)
        valid = [o for o in (before, after) if _offset_at(wall - o.total_seconds()) == o]
        if not valid:
            return before
        if len(set(valid)) == 1:
            return valid[0]
        return max(valid) if dt.fold == 0 else min(valid)

    def dst(self, dt):
        return timedelta(0)

    def tzname(self, dt):
        return 'local'

    def fromutc(self, dt):
        ts = (dt.replace(tzinfo=timezone.utc) - _EPOCH).total_seconds()
        offset = _offset_at(ts)
        return (dt + offset).replace(fold=1 if _offset_at(ts - 3600) > offset else 0)

    def __repr__(self):
        return 'SystemLocal()'


LOCAL = SystemLocal()
