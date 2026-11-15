from pathlib import Path


def vlq(n: int) -> bytes:
    buf = [n & 0x7F]
    n >>= 7
    while n:
        buf.insert(0, (n & 0x7F) | 0x80)
        n >>= 7
    return bytes(buf)


def smf(tracks: list[list[tuple[int, bytes]]], *, fmt: int = 0, tpq: int = 480) -> bytes:
    out = bytearray(b"MThd" + (6).to_bytes(4, "big") + fmt.to_bytes(2, "big")
                    + len(tracks).to_bytes(2, "big") + tpq.to_bytes(2, "big"))
    for events in tracks:
        body = bytearray()
        last = 0
        for tick, raw in sorted(events, key=lambda e: e[0]):
            body += vlq(tick - last) + raw
            last = tick
        body += vlq(0) + b"\xff\x2f\x00"
        out += b"MTrk" + len(body).to_bytes(4, "big") + body
    return bytes(out)


def engine_like(events_ms: list[tuple[float, bytes]]) -> bytes:
    events = [(0, b"\xff\x51\x03\x07\xa1\x20")]
    events += [(round(ms * 0.96), raw) for ms, raw in events_ms]
    return smf([events], fmt=0, tpq=480)


def notes_to_events(notes: list[tuple[int, float, float, int]]) -> list[tuple[float, bytes]]:
    events: list[tuple[float, bytes]] = []
    for pitch, start, end, velocity in notes:
        events.append((start, bytes([0x90, pitch, velocity])))
        events.append((end, bytes([0x80, pitch, 64])))
    return events


def write(path: Path, data: bytes) -> Path:
    path.write_bytes(data)
    return path
