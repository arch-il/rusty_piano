"""Generated scales and arpeggios source `scales`: 972 MusicXML scores (12 keys x 9 kinds x 1, 2 and 4 octaves x right hand, left hand and hands together), with textbook fingering in a .fingering.json sidecar next to each score."""

import xml.etree.ElementTree as ET
from dataclasses import dataclass

from .analyse import ScoreAnalysis
from .difficulty import score_difficulty
from .paths import files_dir
from .sources import Source, SetupStep, UnsupportedCommand

SCALES_VERSION = 1
SOURCE = "scales"
BPM = 80
COMPOSER = "rusty_piano exercises"
LETTERS = "CDEFGAB"
SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
MAJOR = [("C", 0), ("Db", -5), ("D", 2), ("Eb", -3), ("E", 4), ("F", -1), ("F#", 6), ("G", 1), ("Ab", -4),
         ("A", 3), ("Bb", -2), ("B", 5)]  # (tonic name, key fifths) by pitch class 0-11
MINOR = [("C", -3), ("C#", 4), ("D", -1), ("Eb", -6), ("E", 1), ("F", -4), ("F#", 3), ("G", -2), ("G#", 5),
         ("A", 0), ("Bb", -5), ("B", 2)]
SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
MAJOR_KEY_OF_FIFTHS = {-7: "Cb", -6: "Gb", -5: "Db", -4: "Ab", -3: "Eb", -2: "Bb", -1: "F", 0: "C", 1: "G",
                       2: "D", 3: "A", 4: "E", 5: "B", 6: "F#", 7: "C#"}
KINDS = ["major", "minor-natural", "minor-harmonic", "minor-melodic", "arp-major", "arp-minor", "arp-dom7",
         "arp-dim7", "chromatic"]
OCTAVES = (1, 2, 4)
HANDS = ("rh", "lh", "ht")
DEGREES = {
    "major": [(0, 0), (2, 1), (4, 2), (5, 3), (7, 4), (9, 5), (11, 6)],
    "minor-natural": [(0, 0), (2, 1), (3, 2), (5, 3), (7, 4), (8, 5), (10, 6)],
    "minor-harmonic": [(0, 0), (2, 1), (3, 2), (5, 3), (7, 4), (8, 5), (11, 6)],
    "minor-melodic": [(0, 0), (2, 1), (3, 2), (5, 3), (7, 4), (9, 5), (11, 6)],
    "arp-major": [(0, 0), (4, 2), (7, 4)],
    "arp-minor": [(0, 0), (3, 2), (7, 4)],
    "arp-dom7": [(0, 0), (4, 2), (7, 4), (10, 6)],
    "arp-dim7": [(0, 0), (3, 2), (6, 4), (9, 6)],
}
RH_LOW = {1: 55, 2: 50, 4: 41}
TREBLE_WINDOW = (50, 88)
BASS_WINDOW = (31, 71)
WINDOWS = {1: TREBLE_WINDOW, 2: BASS_WINDOW}
MIN_SHIFT_RUN = 4
KIND_TITLE = {"major": "{t} major scale", "minor-natural": "{t} natural minor scale",
              "minor-harmonic": "{t} harmonic minor scale", "minor-melodic": "{t} melodic minor scale",
              "arp-major": "{t} major arpeggio", "arp-minor": "{t} minor arpeggio",
              "arp-dom7": "{t}7 dominant seventh arpeggio", "arp-dim7": "{t} diminished seventh arpeggio",
              "chromatic": "Chromatic scale from {t}"}
OCTAVE_TEXT = {1: "1 octave", 2: "2 octaves", 4: "4 octaves"}
HAND_TEXT = {"rh": "right hand", "lh": "left hand", "ht": "hands together"}
KIND_WORDS = {"major": "major", "minor-natural": "minor natural", "minor-harmonic": "minor harmonic",
              "minor-melodic": "minor melodic", "arp-major": "major triad", "arp-minor": "minor triad",
              "arp-dom7": "dom7 dominant seventh", "arp-dim7": "dim7 diminished seventh", "chromatic": "chromatic"}
HAND_WORDS = {"rh": "rh right", "lh": "lh left", "ht": "ht together both"}
TYPE_NAMES = {16: "whole", 8: "half", 4: "quarter", 2: "eighth", 1: "16th"}
BEATS_DIVISIONS = 4


def _is_minor(kind):
    return kind.startswith("minor-") or kind == "arp-minor"


def tonic_name(kind, pc):
    if kind == "arp-dim7":
        return SHARP_NAMES[pc]
    if _is_minor(kind):
        return MINOR[pc][0]
    return MAJOR[pc][0]


def key_fifths(kind, pc):
    if kind in ("major", "arp-major"):
        return MAJOR[pc][1]
    if _is_minor(kind):
        return MINOR[pc][1]
    if kind == "arp-dom7":
        return MAJOR[pc][1] - 1
    return 0


def key_mode(kind):
    if kind in ("major", "arp-major", "arp-dom7"):
        return "major"
    if _is_minor(kind):
        return "minor"
    return None


def key_name(kind, pc):
    if kind in ("major", "arp-major"):
        return f"{MAJOR[pc][0]} major"
    if _is_minor(kind):
        return f"{MINOR[pc][0]} minor"
    if kind == "arp-dom7":
        return f"{MAJOR_KEY_OF_FIFTHS[key_fifths(kind, pc)]} major"
    return None


def slug(name):
    return name.lower().replace("#", "s")


def node_of(kind, octaves, hand, pc):
    if kind in ("chromatic", "arp-dom7", "arp-dim7") or octaves == 4:
        return "S6"
    if hand == "ht":
        return "S5"
    if octaves == 2:
        return "S4"
    if kind == "major":
        if pc in (0, 7, 5, 2):
            return "S1"
        if pc in (9, 4, 10, 3):
            return "S7"
        return "S8"
    if kind == "minor-harmonic":
        if pc == 9:
            return "S2"
        if pc in (4, 2, 11, 7):
            return "S9"
        if pc in (0, 5, 6, 1):
            return "S10"
        return "S11"
    if kind.startswith("minor-"):
        return "S2"
    return "S3"


@dataclass(frozen=True)
class Scale:
    key: str
    kind: str
    pc: int
    tonic: str
    octaves: int
    hand: str
    title: str
    node: str
    tags: str


def make_scale(kind, pc, octaves, hand):
    tonic = tonic_name(kind, pc)
    key = f"{slug(tonic)}-{kind}-{octaves}oct-{hand}"
    title = KIND_TITLE[kind].format(t=tonic) + ", " + OCTAVE_TEXT[octaves] + ", " + HAND_TEXT[hand]
    node = node_of(kind, octaves, hand, pc)
    tags = (f"{'arpeggio arpeggios' if kind.startswith('arp-') else 'scale scales'} {slug(tonic)} {KIND_WORDS[kind]} "
            f"{octaves}oct {HAND_WORDS[hand]} {node.lower()}")
    return Scale(key, kind, pc, tonic, octaves, hand, title, node, tags)


CATALOGUE = [make_scale(k, pc, o, h) for k in KINDS for pc in range(12) for o in OCTAVES for h in HANDS]
BY_KEY = {s.key: s for s in CATALOGUE}


def tonic_midi(octaves, pc, hand):
    rh = RH_LOW[octaves] + ((pc - RH_LOW[octaves]) % 12)
    return rh - 12 if hand == "lh" else rh


@dataclass(frozen=True)
class Note:
    step: str
    alter: int
    octave: int
    midi: int


def name_parts(name):
    letter = name[0]
    if name.endswith("#"):
        alter = 1
    elif len(name) == 2 and name.endswith("b"):
        alter = -1
    else:
        alter = 0
    return letter, alter


def octave_of(midi, letter, alter):
    return (midi - alter - SEMI[letter]) // 12 - 1


def _spell(tonic, tonic_midi, semis, letters, respell):
    letter, alter = name_parts(tonic)
    base = octave_of(tonic_midi, letter, alter)

    def at(li):
        octave = base + li // 7
        step = LETTERS[li % 7]
        a = tonic_midi + semis - (12 * (octave + 1) + SEMI[step])
        return step, a, octave

    li = LETTERS.index(letter) + letters
    step, a, octave = at(li)
    if respell and a == -2:
        step, a, octave = at(li - 1)
    elif respell and a == 2:
        step, a, octave = at(li + 1)
    if not -2 <= a <= 2:
        raise ValueError(f"{tonic} cannot be spelled {semis} semitones up")
    return Note(step, a, octave, tonic_midi + semis)


def hand_notes(sc, hand):
    n = sc.octaves
    tm = tonic_midi(n, sc.pc, hand)
    if sc.kind == "chromatic":
        steps = [(s, SHARP_NAMES[(tm + s) % 12]) for s in range(12 * n + 1)]
        steps += [(s, FLAT_NAMES[(tm + s) % 12]) for s in range(12 * n - 1, -1, -1)]
        out = []
        for s, name in steps:
            m = tm + s
            if m % 12 == sc.pc:
                name = sc.tonic
            letter, alter = name_parts(name)
            out.append(Note(letter, alter, octave_of(m, letter, alter), m))
        return out
    up = [(12 * o + s, 7 * o + l) for o in range(n) for (s, l) in DEGREES[sc.kind]] + [(12 * n, 7 * n)]
    down_degrees = DEGREES["minor-natural"] if sc.kind == "minor-melodic" else DEGREES[sc.kind]
    down = [(12 * o + s, 7 * o + l) for o in reversed(range(n)) for (s, l) in reversed(down_degrees)]
    return [_spell(sc.tonic, tm, s, l, sc.kind == "arp-dim7") for s, l in up + down]


def octave_shifts(midis, window):
    lo, hi = window

    def fits(m, s):
        return lo <= m + s <= hi

    n = len(midis)
    out = [0] * n
    used = [False] * n
    i = 0
    while i < n:
        if fits(midis[i], 0):
            i += 1
            continue
        end = i
        while end < n and not fits(midis[end], 0):
            end += 1
        run = midis[i:end]
        shift = next((c for c in (-12, 12, -24, 24) if all(fits(m, c) for m in run)), None)
        if shift is None:
            raise ValueError(f"pitches {run} do not fit the staff")
        start = i
        while end - start < MIN_SHIFT_RUN:
            if end < n and not used[end] and fits(midis[end], 0) and fits(midis[end], shift):
                end += 1
            elif start > 0 and not used[start - 1] and fits(midis[start - 1], shift):
                start -= 1
            else:
                break
        for k in range(start, end):
            out[k] = shift
            used[k] = True
        i = end
    return out


def _hands(sc):
    out = []
    if sc.hand in ("rh", "ht"):
        out.append((1, hand_notes(sc, "rh")))
    if sc.hand in ("lh", "ht"):
        out.append((2, hand_notes(sc, "lh")))
    return out


def _timing(length, octaves):
    d = BEATS_DIVISIONS // octaves
    run_total = d * (length - 1)
    rem = run_total % 16
    last = 16 - rem if rem else 16
    durs = [d] * (length - 1) + [last]
    starts = []
    t = 0
    for du in durs:
        starts.append(t)
        t += du
    return d, durs, starts, run_total + last


def _text(parent, tag, text):
    e = ET.SubElement(parent, tag)
    e.text = str(text)
    return e


def _direction(m, s, stop, staff):
    d = ET.SubElement(m, "direction", {"placement": "above" if s < 0 else "below"})
    dt = ET.SubElement(d, "direction-type")
    kind = "stop" if stop else ("down" if s < 0 else "up")
    ET.SubElement(dt, "octave-shift", {"type": kind, "size": "8" if abs(s) == 12 else "15", "number": "1"})
    _text(d, "staff", staff)


def _note(m, notes, j, durs, staff, d):
    note = notes[j]
    n = ET.SubElement(m, "note")
    p = ET.SubElement(n, "pitch")
    _text(p, "step", note.step)
    if note.alter:
        _text(p, "alter", note.alter)
    _text(p, "octave", note.octave)
    _text(n, "duration", durs[j])
    _text(n, "voice", staff)
    _text(n, "type", TYPE_NAMES[durs[j]])
    _text(n, "staff", staff)
    if d < 4 and j < len(notes) - 1:
        per = 4 // d
        pos = j % per
        text = "begin" if pos == 0 else "end" if pos == per - 1 else "continue"
        for num in (("1",) if d == 2 else ("1", "2")):
            b = ET.SubElement(n, "beam", {"number": num})
            b.text = text


def _rest(m, staff):
    n = ET.SubElement(m, "note")
    ET.SubElement(n, "rest", {"measure": "yes"})
    _text(n, "duration", 16)
    _text(n, "voice", staff)
    _text(n, "type", "whole")
    _text(n, "staff", staff)


def musicxml(sc) -> str:
    root = ET.Element("score-partwise", {"version": "4.0"})
    work = ET.SubElement(root, "work")
    _text(work, "work-title", sc.title)
    ident = ET.SubElement(root, "identification")
    c = _text(ident, "creator", COMPOSER)
    c.set("type", "composer")
    plist = ET.SubElement(root, "part-list")
    sp = ET.SubElement(plist, "score-part", {"id": "P1"})
    _text(sp, "part-name", "Piano")
    inst = ET.SubElement(sp, "midi-instrument", {"id": "P1-I1"})
    _text(inst, "midi-program", 1)
    part = ET.SubElement(root, "part", {"id": "P1"})
    hands = _hands(sc)
    d, durs, starts, total = _timing(len(hands[0][1]), sc.octaves)
    plan = {}
    for staff, notes in hands:
        shifts = octave_shifts([n.midi for n in notes], WINDOWS[staff])
        ops = []
        prev = 0
        for s in shifts:
            op = []
            if s != prev:
                if prev != 0:
                    op.append((prev, True))
                if s != 0:
                    op.append((s, False))
                prev = s
            ops.append(op)
        trailing = [(prev, True)] if prev != 0 else []
        plan[staff] = (notes, ops, trailing)
    for i in range(total // 16):
        m = ET.SubElement(part, "measure", {"number": str(i + 1)})
        if i == 0:
            attrs = ET.SubElement(m, "attributes")
            _text(attrs, "divisions", BEATS_DIVISIONS)
            key = ET.SubElement(attrs, "key")
            _text(key, "fifths", key_fifths(sc.kind, sc.pc))
            if key_mode(sc.kind):
                _text(key, "mode", key_mode(sc.kind))
            time = ET.SubElement(attrs, "time")
            _text(time, "beats", 4)
            _text(time, "beat-type", 4)
            _text(attrs, "staves", 2)
            for num, sign, line in ((1, "G", 2), (2, "F", 4)):
                clef = ET.SubElement(attrs, "clef", {"number": str(num)})
                _text(clef, "sign", sign)
                _text(clef, "line", line)
            md = ET.SubElement(m, "direction", {"placement": "above"})
            dt = ET.SubElement(md, "direction-type")
            met = ET.SubElement(dt, "metronome")
            _text(met, "beat-unit", "quarter")
            _text(met, "per-minute", BPM)
            _text(md, "staff", 1)
            ET.SubElement(md, "sound", {"tempo": str(BPM)})
        for staff in (1, 2):
            if staff == 2:
                b = ET.SubElement(m, "backup")
                _text(b, "duration", 16)
            if staff not in plan:
                _rest(m, staff)
                continue
            notes, ops, trailing = plan[staff]
            for j in range(len(notes)):
                if starts[j] // 16 != i:
                    continue
                for s, stop in ops[j]:
                    _direction(m, s, stop, staff)
                _note(m, notes, j, durs, staff, d)
                if j == len(notes) - 1:
                    for s, stop in trailing:
                        _direction(m, s, stop, staff)
        if i == total // 16 - 1:
            bl = ET.SubElement(m, "barline", {"location": "right"})
            _text(bl, "bar-style", "light-heavy")
    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")


def analysis(sc) -> ScoreAnalysis:
    hands = _hands(sc)
    _, _, _, total = _timing(len(hands[0][1]), sc.octaves)
    notes = [n for _, ns in hands for n in ns]
    midis = [n.midi for n in notes]
    return ScoreAnalysis(
        title=sc.title,
        composer=COMPOSER,
        key=key_name(sc.kind, sc.pc),
        time_signature="4/4",
        seconds=round(total // 16 * 4 * 60 / BPM, 1),
        n_notes=len(notes),
        pitch_range=max(midis) - min(midis),
        chord_ratio=0.0,
        staves=2 if sc.hand == "ht" else 1,
        accidental_ratio=sum(1 for n in notes if n.alter != 0) / len(notes),
        piano_only=True,
    )


def generate(lib, progress=None, keys=None) -> list[str]:
    # 972 small writes; WAL mode keeps the index safe
    lib.conn.execute("PRAGMA synchronous=NORMAL")
    from .scale_fingering import write_scale_sidecar
    out = files_dir(lib.data_dir, SOURCE)
    chosen = CATALOGUE if keys is None else [sc for sc in CATALOGUE if sc.key in keys]
    records = []
    for sc in chosen:
        path = out / f"{sc.key}.musicxml"
        text = musicxml(sc)
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            path.write_text(text, encoding="utf-8")
        write_scale_sidecar(sc, path)
        records.append({
            "id": "scales:" + sc.key,
            "source": SOURCE,
            "title": sc.title,
            "composer": COMPOSER,
            "tags": sc.tags,
            "license": "CC0-1.0",
            "attribution": "Generated by rusty_piano coach",
            "license_conflict": 0,
            "source_ref": f"scales generator v{SCALES_VERSION}",
        })
    lib.upsert_catalogue(records)
    ids = []
    for i, sc in enumerate(chosen):
        path = out / f"{sc.key}.musicxml"
        a = analysis(sc)
        score_id = "scales:" + sc.key
        lib.update_analysis(
            score_id,
            file_path=path.relative_to(lib.data_dir).as_posix(),
            key=a.key,
            time_signature="4/4",
            seconds=a.seconds,
            n_notes=a.n_notes,
            piano_only=True,
            difficulty=score_difficulty(a, None),
        )
        ids.append(score_id)
        if progress:
            progress("Making scales", i + 1, len(chosen), "items")
    return ids


class ScalesSource(Source):
    name = "scales"
    label = "Scales and arpeggios"
    description = "Scales and arpeggios in all 12 keys, made by the coach (1, 2 and 4 octaves, each hand and hands together)"
    keeps_catalogue_row = False

    def sync(self, lib, from_file):
        if from_file is not None:
            raise UnsupportedCommand("scales makes its scores itself; --from is not used")
        n = len(generate(lib))
        print(f"Generated {n} scales and arpeggios in {files_dir(lib.data_dir, SOURCE)}")
        return n

    def setup_steps(self, lib):
        count = lib.conn.execute(
            "SELECT COUNT(*) FROM scores WHERE source='scales' AND file_path IS NOT NULL").fetchone()[0]

        def present(sc):
            row = lib.get("scales:" + sc.key)
            return bool(row and row["file_path"] and (lib.data_dir / row["file_path"]).exists())

        done = count >= len(CATALOGUE) and present(CATALOGUE[0]) and present(CATALOGUE[-1])
        return [SetupStep("scales", "Scales and arpeggios",
                          f"Makes {len(CATALOGUE)} scale and arpeggio scores in all keys",
                          "the scales skill track", done)]

    def run_setup_step(self, lib, step_id, progress=None):
        if step_id != "scales":
            raise LookupError(f"no setup step '{step_id}'")
        generate(lib, progress)
        return f"Made {len(CATALOGUE)} scales and arpeggios"

    def search(self, lib, text, *, difficulty=None, key=None, time_signature=None, limit=50):
        return []

    def download(self, lib, ids, progress=None):
        for i in ids:
            print(f"{i} is a generated scale; make them with: coach scores sync scales")
        return []
