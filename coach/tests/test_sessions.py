from datetime import datetime, timezone

import pytest
from mid_fixtures import engine_like, notes_to_events, smf, write

from rusty_piano_coach.sessions import (
    PedalEvent,
    PlayedNote,
    Session,
    find_session_for_attempt,
    notes_from_events,
    parse_midi,
    read_midi,
    resolve_session,
    session_from_attempt_events,
    session_start_from_name,
    sessions_in,
    window,
)

UTC = timezone.utc
HEADER = b"MThd" + (6).to_bytes(4, "big") + b"\x00\x00\x00\x01\x01\xe0"


def test_engine_like_round_trip(tmp_path):
    data = engine_like(notes_to_events([(62, 1500, 2000, 80), (60, 1000, 1500, 90)]))
    path = write(tmp_path / "session-20261104-210913.mid", data)

    session = read_midi(path)

    assert session.started_at == datetime(2026, 11, 4, 21, 9, 13, tzinfo=UTC)
    assert [(n.pitch, n.velocity, n.open) for n in session.notes] == [(60, 90, False), (62, 80, False)]
    assert session.notes[0].start_ms == pytest.approx(1000, abs=1.1)
    assert session.notes[0].end_ms == pytest.approx(1500, abs=1.1)
    assert session.notes[1].start_ms == pytest.approx(1500, abs=1.1)
    assert session.notes[1].end_ms == pytest.approx(2000, abs=1.1)


def test_running_status_and_velocity_zero_off():
    track = (
        b"\x00\x90\x3c\x40"
        + b"\x83\x60\x3e\x40"
        + b"\x83\x60\x3c\x00"
        + b"\x00\xff\x2f\x00"
    )
    data = HEADER + b"MTrk" + len(track).to_bytes(4, "big") + track

    assert parse_midi(data) == [
        (0.0, "on", 60, 64),
        (500.0, "on", 62, 64),
        (1000.0, "off", 60, 0),
    ]
    notes, _ = notes_from_events(parse_midi(data))
    assert notes == [
        PlayedNote(60, 0.0, 1000.0, 64),
        PlayedNote(62, 500.0, 1000.0, 64, True),
    ]


def test_format_1_with_tempo_track():
    data = smf(
        [
            [(0, b"\xff\x51\x03\x07\xa1\x20"), (960, b"\xff\x51\x03\x0f\x42\x40")],
            [(960, b"\x90\x3c\x64"), (1440, b"\x80\x3c\x40")],
        ],
        fmt=1,
        tpq=480,
    )

    assert parse_midi(data) == [(1000.0, "on", 60, 100), (2000.0, "off", 60, 0)]


def test_pedal_state_changes_only():
    data = smf([[(0, b"\xb0\x40\x7f"), (480, b"\xb0\x40\x7f"), (960, b"\xb0\x40\x00")]])

    _, pedal = notes_from_events(parse_midi(data))

    assert pedal == [PedalEvent(0.0, True), PedalEvent(1000.0, False)]


def test_unclosed_note_is_open_until_last_event():
    data = smf([[(0, b"\x90\x3c\x40"), (480, b"\x90\x3e\x40"), (960, b"\x80\x3e\x40")]])

    notes, _ = notes_from_events(parse_midi(data))

    assert notes == [
        PlayedNote(60, 0.0, 1000.0, 64, True),
        PlayedNote(62, 500.0, 1000.0, 64),
    ]


def test_not_a_midi_file():
    with pytest.raises(ValueError, match="not a MIDI file"):
        parse_midi(b"hello")


def test_truncated_midi_file():
    data = smf([[(0, b"\x90\x3c\x40"), (480, b"\x80\x3c\x40")]])

    with pytest.raises(ValueError, match="truncated"):
        parse_midi(data[:-5])


def test_session_start_from_name():
    assert session_start_from_name("session-20261104-210913.mid") == datetime(2026, 11, 4, 21, 9, 13, tzinfo=UTC)
    assert session_start_from_name("my-take-1.mid") is None


def test_latest_session_is_newest_and_other_files_ignored(tmp_path):
    older = write(tmp_path / "session-20261104-210000.mid", engine_like([]))
    newer = write(tmp_path / "session-20261104-220000.mid", engine_like([]))
    write(tmp_path / "other.mid", engine_like([]))

    assert sessions_in(tmp_path) == [older, newer]
    assert resolve_session("latest", tmp_path) == newer


def test_resolve_missing_path_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        resolve_session(str(tmp_path / "missing.mid"), tmp_path)


def test_window_keeps_only_notes_in_range():
    session = Session(
        path=None,
        started_at=None,
        notes=[
            PlayedNote(60, 1000.0, 1400.0, 64),
            PlayedNote(62, 2000.0, 2400.0, 64),
            PlayedNote(64, 3000.0, 3400.0, 64),
        ],
        pedal=[PedalEvent(1200.0, True), PedalEvent(2600.0, False)],
        first_ms=1000.0,
        last_ms=3400.0,
    )

    cut = window(session, 1500, 2500)

    assert cut.notes == [PlayedNote(62, 2000.0, 2400.0, 64)]
    assert cut.pedal == []
    assert window(session, 5000, 6000).first_ms is None


def _attempt_session_notes(folder, extra=()):
    notes = [(60, 5000, 5400, 64), (62, 5500, 5900, 64), (64, 6000, 6400, 64), *extra]
    return engine_like(notes_to_events(notes))


def _engine_events(pitches_and_times, end_t=None):
    events = [
        {"type": "note_on", "t": t, "page_ms": t, "source": "engine", "note": note, "velocity": 64}
        for note, t in pitches_and_times
    ]
    if end_t is not None:
        events.append({"type": "note_off", "t": end_t, "page_ms": end_t, "source": "engine", "note": 64})
    return events


def test_attempt_matches_the_right_session(tmp_path):
    write(tmp_path / "session-20261104-210000.mid", _attempt_session_notes(tmp_path))
    late = write(
        tmp_path / "session-20261104-220000.mid",
        _attempt_session_notes(tmp_path, extra=[(65, 9000, 9400, 64)]),
    )
    attempt = {
        "started_at": "2026-11-04T22:01:00Z",
        "events": _engine_events([(60, 5000), (62, 5500), (64, 6000)], end_t=6400),
    }

    match = find_session_for_attempt(attempt, tmp_path)

    assert match is not None
    assert match.path == late
    assert match.start_ms == 5000
    assert match.end_ms == 6400
    assert match.matched == 3
    assert match.total == 3


def test_attempt_before_later_session_matches_earlier_file(tmp_path):
    early = write(tmp_path / "session-20261104-210000.mid", _attempt_session_notes(tmp_path))
    write(tmp_path / "session-20261104-220000.mid", _attempt_session_notes(tmp_path))
    attempt = {
        "started_at": "2026-11-04T21:30:00Z",
        "events": _engine_events([(60, 5000), (62, 5500), (64, 6000)], end_t=6400),
    }

    match = find_session_for_attempt(attempt, tmp_path)

    assert match is not None
    assert match.path == early


def test_wrong_pitches_do_not_match(tmp_path):
    write(tmp_path / "session-20261104-220000.mid", _attempt_session_notes(tmp_path))
    attempt = {
        "started_at": "2026-11-04T22:01:00Z",
        "events": _engine_events([(61, 5000), (63, 5500), (66, 6000)]),
    }

    assert find_session_for_attempt(attempt, tmp_path) is None


def test_autoplay_only_attempt_does_not_match(tmp_path):
    write(tmp_path / "session-20261104-220000.mid", _attempt_session_notes(tmp_path))
    attempt = {
        "started_at": "2026-11-04T22:01:00Z",
        "events": [
            {"type": "note_on", "t": 5000, "page_ms": 5000, "source": "autoplay", "note": 60, "velocity": 64},
        ],
    }

    assert find_session_for_attempt(attempt, tmp_path) is None


def test_attempt_events_are_timed_by_page_ms():
    attempt = {
        "started_at": "2026-11-04T22:01:00Z",
        "events": [
            {"type": "note_on", "t": 1, "page_ms": 100.0, "source": "keyboard", "note": 60, "velocity": 64},
            {"type": "sustain", "t": 2, "page_ms": 150.0, "source": "keyboard", "on": True},
            {"type": "note_off", "t": 3, "page_ms": 400.0, "source": "keyboard", "note": 60},
            {"type": "note_on", "t": 4, "page_ms": 500.0, "source": "autoplay", "note": 62, "velocity": 70},
            {"type": "note_on", "t": 5, "page_ms": 700.0, "source": "autoplay", "note": 62, "velocity": 0},
        ],
    }

    session = session_from_attempt_events(attempt)

    assert session.path is None
    assert session.started_at == datetime(2026, 11, 4, 22, 1, tzinfo=UTC)
    assert session.notes == [PlayedNote(60, 100.0, 400.0, 64), PlayedNote(62, 500.0, 700.0, 70)]
    assert session.pedal == [PedalEvent(150.0, True)]
