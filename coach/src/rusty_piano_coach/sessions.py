"""Loads recorded practice sessions (.mid files written by the engine) into timed notes and pedal events, and finds the session .mid that matches a saved attempt by engine time."""

import bisect
import re
from collections import deque
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_TEMPO_US = 500000
NAME_RE = re.compile(r"session-(\d{8})-(\d{6})\.mid")


@dataclass(frozen=True)
class PlayedNote:
    pitch: int
    start_ms: float
    end_ms: float
    velocity: int
    open: bool = False


@dataclass(frozen=True)
class PedalEvent:
    t_ms: float
    on: bool


@dataclass
class Session:
    path: Path | None
    started_at: datetime | None
    notes: list[PlayedNote]
    pedal: list[PedalEvent]
    first_ms: float | None
    last_ms: float | None


@dataclass(frozen=True)
class SessionMatch:
    path: Path
    start_ms: float
    end_ms: float
    matched: int
    total: int


def _take(data: bytes, pos: int, count: int, end: int) -> bytes:
    if pos + count > end:
        raise ValueError("MIDI file is truncated")
    return data[pos:pos + count]


def _vlq(data: bytes, pos: int, end: int) -> tuple[int, int]:
    value = 0
    while True:
        byte = _take(data, pos, 1, end)[0]
        pos += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, pos


def _read_track(data: bytes, pos: int, end: int, events: list, tempos: list) -> None:
    tick = 0
    running = 0
    status = 0
    while pos < end:
        delta, pos = _vlq(data, pos, end)
        tick += delta
        byte = _take(data, pos, 1, end)[0]
        if byte & 0x80:
            status = byte
            pos += 1
            if status < 0xF0:
                running = status
        elif running:
            status = running
        else:
            raise ValueError("MIDI file is corrupt")

        if status == 0xFF:
            meta_type = _take(data, pos, 1, end)[0]
            length, pos = _vlq(data, pos + 1, end)
            body = _take(data, pos, length, end)
            if meta_type == 0x51 and length == 3:
                tempos.append((tick, int.from_bytes(body, "big")))
            pos += length
            running = 0
        elif status in (0xF0, 0xF7):
            length, pos = _vlq(data, pos, end)
            _take(data, pos, length, end)
            pos += length
            running = 0
        elif status >= 0xF0:
            raise ValueError("unsupported MIDI event")
        else:
            high = status & 0xF0
            count = 1 if high in (0xC0, 0xD0) else 2
            values = _take(data, pos, count, end)
            pos += count
            a = values[0]
            b = values[1] if count == 2 else 0
            if high == 0x90 and b > 0:
                events.append((tick, "on", a, b))
            elif high in (0x80, 0x90):
                events.append((tick, "off", a, 0))
            elif high == 0xB0:
                events.append((tick, "cc", a, b))


def _to_ms(tick: int, division: int, tempos: list) -> float:
    ms = 0.0
    prev_tick, prev_us = 0, DEFAULT_TEMPO_US
    for change_tick, us in tempos:
        if change_tick > tick:
            break
        ms += (change_tick - prev_tick) * prev_us / division / 1000
        prev_tick, prev_us = change_tick, us
    return ms + (tick - prev_tick) * prev_us / division / 1000


def parse_midi(data: bytes) -> list[tuple[float, str, int, int]]:
    if data[:4] != b"MThd":
        raise ValueError("not a MIDI file")
    if len(data) < 14:
        raise ValueError("MIDI file is truncated")
    if int.from_bytes(data[4:8], "big") != 6:
        raise ValueError("not a MIDI file")
    if int.from_bytes(data[8:10], "big") not in (0, 1, 2):
        raise ValueError("not a MIDI file")
    division = int.from_bytes(data[12:14], "big")
    if division & 0x8000:
        raise ValueError("SMPTE time division is not supported")

    events: list = []
    tempos: list = []
    pos = 14
    while pos < len(data):
        chunk_id = _take(data, pos, 4, len(data))
        length = int.from_bytes(_take(data, pos + 4, 4, len(data)), "big")
        start = pos + 8
        end = start + length
        if end > len(data):
            raise ValueError("MIDI file is truncated")
        if chunk_id == b"MTrk":
            _read_track(data, start, end, events, tempos)
        pos = end

    tempos.sort(key=lambda t: t[0])
    merged = [(_to_ms(tick, division, tempos), kind, a, b) for tick, kind, a, b in events]
    merged.sort(key=lambda e: e[0])
    return merged


def notes_from_events(events: list[tuple[float, str, int, int]]) -> tuple[list[PlayedNote], list[PedalEvent]]:
    notes: list[PlayedNote] = []
    pedal: list[PedalEvent] = []
    open_notes: dict[int, deque] = {}
    state = False
    for ms, kind, a, b in events:
        if kind == "on":
            open_notes.setdefault(a, deque()).append((ms, b))
        elif kind == "off":
            queue = open_notes.get(a)
            if queue:
                start, velocity = queue.popleft()
                notes.append(PlayedNote(a, start, ms, velocity))
        elif kind == "cc" and a == 64:
            on = b >= 64
            if on != state:
                pedal.append(PedalEvent(ms, on))
                state = on
    last_ms = events[-1][0] if events else 0.0
    for pitch, queue in open_notes.items():
        for start, velocity in queue:
            notes.append(PlayedNote(pitch, start, last_ms, velocity, True))
    notes.sort(key=lambda n: (n.start_ms, n.pitch))
    return notes, pedal


def read_midi(path: Path) -> Session:
    events = parse_midi(path.read_bytes())
    notes, pedal = notes_from_events(events)
    return Session(
        path=path,
        started_at=session_start_from_name(path.name),
        notes=notes,
        pedal=pedal,
        first_ms=events[0][0] if events else None,
        last_ms=events[-1][0] if events else None,
    )


def session_start_from_name(name: str) -> datetime | None:
    match = NAME_RE.fullmatch(name)
    if match is None:
        return None
    try:
        parsed = datetime.strptime(match.group(1) + match.group(2), "%Y%m%d%H%M%S")
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc)


def sessions_in(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    paths = [
        p for p in folder.glob("session-*.mid")
        if p.is_file() and session_start_from_name(p.name) is not None
    ]
    return sorted(paths, key=lambda p: p.name)


def resolve_session(arg: str, folder: Path) -> Path:
    if arg == "latest":
        found = sessions_in(folder)
        if not found:
            raise FileNotFoundError(f"no recorded sessions in {folder}")
        return found[-1]
    path = Path(arg)
    if not path.is_file():
        raise FileNotFoundError(f"no such file: {arg}")
    return path


def window(session: Session, start_ms: float, end_ms: float) -> Session:
    notes = [n for n in session.notes if start_ms <= n.start_ms <= end_ms]
    pedal = [p for p in session.pedal if start_ms <= p.t_ms <= end_ms]
    starts = [n.start_ms for n in notes] + [p.t_ms for p in pedal]
    ends = [n.end_ms for n in notes] + [p.t_ms for p in pedal]
    return replace(
        session,
        notes=notes,
        pedal=pedal,
        first_ms=min(starts) if starts else None,
        last_ms=max(ends) if ends else None,
    )


def session_from_attempt_events(attempt: dict) -> Session:
    events: list[tuple[float, str, int, int]] = []
    for event in attempt["events"]:
        ms = event["page_ms"]
        kind = event["type"]
        if kind == "note_on" and event["velocity"] > 0:
            events.append((ms, "on", event["note"], event["velocity"]))
        elif kind in ("note_on", "note_off"):
            events.append((ms, "off", event["note"], 0))
        elif kind == "sustain":
            events.append((ms, "cc", 64, 127 if event["on"] else 0))
    events.sort(key=lambda e: e[0])
    notes, pedal = notes_from_events(events)
    return Session(
        path=None,
        started_at=datetime.fromisoformat(attempt["started_at"]),
        notes=notes,
        pedal=pedal,
        first_ms=events[0][0] if events else None,
        last_ms=events[-1][0] if events else None,
    )


def find_session_for_attempt(
    attempt: dict,
    folder: Path,
    *,
    tolerance_ms: float = 3.0,
    min_fraction: float = 0.8,
) -> SessionMatch | None:
    engine = [e for e in attempt["events"] if e["source"] == "engine"]
    ons = [(e["t"], e["note"]) for e in engine if e["type"] == "note_on" and e["velocity"] > 0]
    if not ons:
        return None
    limit = datetime.fromisoformat(attempt["started_at"]) + timedelta(seconds=60)
    candidates = [p for p in sessions_in(folder) if session_start_from_name(p.name) <= limit]
    times = [e["t"] for e in engine]
    for path in reversed(candidates):
        try:
            session = read_midi(path)
        except (ValueError, OSError):
            continue
        starts: dict[int, list[float]] = {}
        for note in session.notes:
            starts.setdefault(note.pitch, []).append(note.start_ms)
        matched = 0
        for t, pitch in ons:
            values = starts.get(pitch, [])
            i = bisect.bisect_left(values, t - tolerance_ms)
            if i < len(values) and values[i] <= t + tolerance_ms:
                matched += 1
        if matched / len(ons) >= min_fraction:
            return SessionMatch(
                path=path,
                start_ms=min(times),
                end_ms=max(times),
                matched=matched,
                total=len(ons),
            )
    return None
