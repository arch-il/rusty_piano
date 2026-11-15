import random
import xml.etree.ElementTree as ET
from dataclasses import dataclass

from .analyse import analyse_file
from .difficulty import score_difficulty
from .paths import files_dir
from .sources import Source, SetupStep, UnsupportedCommand

GEN_VERSION = 1

DIVISIONS = {"w": 16, "h": 8, "q": 4, "e": 2}
TYPE_NAMES = {"w": "whole", "h": "half", "q": "quarter", "e": "eighth"}
SEMITONES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


@dataclass(frozen=True)
class Exercise:
    key: str
    title: str
    node: str
    track: str
    staff: int
    bpm: int
    music: str


def melody(seed, scale):
    rnd = random.Random(seed)
    pos = 0
    picked = []
    for _ in range(12):
        moves = [m for m in (-2, -1, 1, 2) if 0 <= pos + m <= 4]
        pos += rnd.choice(moves)
        picked.append(scale[pos])
    bars = [" ".join(picked[i:i + 4]) for i in range(0, 12, 4)]
    bars.append(f"{scale[0]}:w")
    return " | ".join(bars)


def _down_octave(music):
    out = []
    for tok in music.split():
        if tok == "|":
            out.append(tok)
            continue
        name, _, suffix = tok.partition(":")
        name = name[:-1] + str(int(name[-1]) - 1)
        out.append(name + (":" + suffix if suffix else ""))
    return " ".join(out)


_UP5 = ["C4", "D4", "E4", "F4", "G4"]
_LOW5 = ["C3", "D3", "E3", "F3", "G3"]
_STEPS = "C4 D4 E4 F4 | G4 F4 E4 D4 | C4:w"
_SKIPS = "C4 E4 D4 F4 | E4 G4 F4 D4 | C4:w"
_MIXED = "C4:h D4:h | E4 E4 D4:h | C4:w | E4 F4 G4:h | E4:h D4:h | C4:w"
_FIVE = "C4 D4 E4 F4 | G4 F4 E4 D4 | C4 D4 E4 F4 | G4 F4 E4 D4 | C4:w"
_EIGHTHS = " | ".join(["C4:e D4:e E4:e F4:e G4:e F4:e E4:e D4:e"] * 3 + ["C4:w"])
_QUARTERS = " | ".join(["C4 C4 C4 C4"] * 4)

CATALOGUE: list[Exercise] = [
    Exercise("r1-all-cs", "R1 Find every C", "R1", "reading", 0, 60,
             "C2:w | C3:w | C4:w | C5:w | C6:w | C5:w | C4:w | C3:w"),
    Exercise("r1-two-black", "R1 C D E around the two black keys", "R1", "reading", 0, 60,
             "C3 D3 E3:h | C4 D4 E4:h | C5 D5 E5:h | C4:w"),
    Exercise("r1-three-black", "R1 F G A B around the three black keys", "R1", "reading", 0, 60,
             "F3 G3 A3 B3 | F4 G4 A4 B4 | F5 G5 A5 B5 | C5:w"),
    Exercise("r2-steps", "R2 Steps up and down (right hand)", "R2", "reading", 1, 60, _STEPS),
    Exercise("r2-skips", "R2 Skips (right hand)", "R2", "reading", 1, 60, _SKIPS),
]
for _n in range(1, 7):
    CATALOGUE.append(Exercise(f"r2-read-{_n}", f"R2 Reading snippet {_n} (right hand)", "R2", "reading", 1, 60,
                              melody(100 + _n, _UP5)))
CATALOGUE += [
    Exercise("r3-steps", "R3 Steps up and down (left hand)", "R3", "reading", 2, 60, _down_octave(_STEPS)),
    Exercise("r3-skips", "R3 Skips (left hand)", "R3", "reading", 2, 60, _down_octave(_SKIPS)),
]
for _n in range(1, 7):
    CATALOGUE.append(Exercise(f"r3-read-{_n}", f"R3 Reading snippet {_n} (left hand)", "R3", "reading", 2, 60,
                              melody(200 + _n, _LOW5)))
CATALOGUE += [
    Exercise("t1-quarters-rh", "T1 Quarter notes (right hand)", "T1", "rhythm", 1, 80, _QUARTERS),
    Exercise("t1-quarters-lh", "T1 Quarter notes (left hand)", "T1", "rhythm", 2, 80, _down_octave(_QUARTERS)),
    Exercise("t1-quarters-cg", "T1 C and G quarters (right hand)", "T1", "rhythm", 1, 80,
             "C4 C4 G4 G4 | G4 G4 C4 C4 | C4 G4 C4 G4 | C4:w"),
    Exercise("t2-halves-rh", "T2 Half notes (right hand)", "T2", "rhythm", 1, 72,
             "C4:h C4:h | E4:h E4:h | G4:h G4:h | C4:w"),
    Exercise("t2-wholes-rh", "T2 Whole notes (right hand)", "T2", "rhythm", 1, 72,
             "C4:w | E4:w | G4:w | C4:w"),
    Exercise("t2-mixed-rh", "T2 Mixed note lengths (right hand)", "T2", "rhythm", 1, 72, _MIXED),
    Exercise("t2-mixed-lh", "T2 Mixed note lengths (left hand)", "T2", "rhythm", 2, 72, _down_octave(_MIXED)),
    Exercise("k1-c5-rh", "K1 Five-finger C position (right hand)", "K1", "keys", 1, 80, _FIVE),
    Exercise("k1-c5-lh", "K1 Five-finger C position (left hand)", "K1", "keys", 2, 80, _down_octave(_FIVE)),
    Exercise("k1-c5-eighths-rh", "K1 Five-finger C eighths (right hand)", "K1", "keys", 1, 60, _EIGHTHS),
    Exercise("k1-c5-eighths-lh", "K1 Five-finger C eighths (left hand)", "K1", "keys", 2, 60,
             _down_octave(_EIGHTHS)),
]


def _parse_note(tok):
    name, _, suffix = tok.partition(":")
    kind = suffix or "q"
    step = name[0]
    alter = 1 if name[1] == "#" else 0
    octave = int(name[-1])
    midi = 12 * (octave + 1) + SEMITONES[step] + alter
    return step, alter, octave, midi, kind


def _bars(ex):
    bars = []
    for text in ex.music.split("|"):
        notes = [_parse_note(t) for t in text.split()]
        if sum(DIVISIONS[n[4]] for n in notes) != 16:
            raise ValueError(f"{ex.key}: bar '{text.strip()}' is not 4 quarters")
        bars.append(notes)
    return bars


def _staff_of(ex, note):
    if ex.staff:
        return ex.staff
    return 1 if note[3] >= 60 else 2


def _text(parent, tag, text):
    e = ET.SubElement(parent, tag)
    e.text = str(text)
    return e


def _note_el(measure, note, staff):
    n = ET.SubElement(measure, "note")
    if note is None:
        ET.SubElement(n, "rest", {"measure": "yes"})
        kind = "w"
    else:
        step, alter, octave, _, kind = note
        p = ET.SubElement(n, "pitch")
        _text(p, "step", step)
        if alter:
            _text(p, "alter", alter)
        _text(p, "octave", octave)
    _text(n, "duration", DIVISIONS[kind])
    _text(n, "voice", staff)
    _text(n, "type", TYPE_NAMES[kind])
    _text(n, "staff", staff)


def musicxml(ex) -> str:
    root = ET.Element("score-partwise", {"version": "4.0"})
    work = ET.SubElement(root, "work")
    _text(work, "work-title", ex.title)
    ident = ET.SubElement(root, "identification")
    c = _text(ident, "creator", "rusty_piano exercises")
    c.set("type", "composer")
    plist = ET.SubElement(root, "part-list")
    sp = ET.SubElement(plist, "score-part", {"id": "P1"})
    _text(sp, "part-name", "Piano")
    inst = ET.SubElement(sp, "midi-instrument", {"id": "P1-I1"})
    _text(inst, "midi-program", 1)
    part = ET.SubElement(root, "part", {"id": "P1"})
    bars = _bars(ex)
    for i, notes in enumerate(bars):
        m = ET.SubElement(part, "measure", {"number": str(i + 1)})
        if i == 0:
            attrs = ET.SubElement(m, "attributes")
            _text(attrs, "divisions", 4)
            key = ET.SubElement(attrs, "key")
            _text(key, "fifths", 0)
            time = ET.SubElement(attrs, "time")
            _text(time, "beats", 4)
            _text(time, "beat-type", 4)
            _text(attrs, "staves", 2)
            for num, sign, line in ((1, "G", 2), (2, "F", 4)):
                clef = ET.SubElement(attrs, "clef", {"number": str(num)})
                _text(clef, "sign", sign)
                _text(clef, "line", line)
            d = ET.SubElement(m, "direction", {"placement": "above"})
            dt = ET.SubElement(d, "direction-type")
            met = ET.SubElement(dt, "metronome")
            _text(met, "beat-unit", "quarter")
            _text(met, "per-minute", ex.bpm)
            _text(d, "staff", 1)
            ET.SubElement(d, "sound", {"tempo": str(ex.bpm)})
        for staff in (1, 2):
            if staff == 2:
                b = ET.SubElement(m, "backup")
                _text(b, "duration", 16)
            mine = [n for n in notes if _staff_of(ex, n) == staff]
            if mine:
                for n in mine:
                    _note_el(m, n, staff)
            else:
                _note_el(m, None, staff)
        if i == len(bars) - 1:
            bl = ET.SubElement(m, "barline", {"location": "right"})
            _text(bl, "bar-style", "light-heavy")
    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")


def all_exercises() -> list:
    from . import genx

    exercises = list(CATALOGUE) + genx.all_exercises()
    seen = set()
    dups = []
    for ex in exercises:
        if ex.key in seen:
            dups.append(ex.key)
        seen.add(ex.key)
    if dups:
        raise ValueError(f"duplicate exercise keys: {', '.join(dups)}")
    return exercises


def exercise_xml(ex) -> str:
    return musicxml(ex) if isinstance(ex, Exercise) else ex.musicxml()


def generate(lib, progress=None) -> list[str]:
    out = files_dir(lib.data_dir, "gen")
    ids = []
    exercises = all_exercises()
    for i, ex in enumerate(exercises):
        path = out / f"{ex.key}.musicxml"
        text = exercise_xml(ex)
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            path.write_text(text, encoding="utf-8")
        a = analyse_file(path)
        score_id = "gen:" + ex.key
        lib.upsert_catalogue([{
            "id": score_id,
            "source": "gen",
            "title": ex.title,
            "composer": getattr(ex, "composer", "rusty_piano exercises"),
            "tags": getattr(ex, "tags", f"exercise beginner {ex.node.lower()} {ex.track}"),
            "license": "CC0-1.0",
            "attribution": "Generated by rusty_piano coach",
            "license_conflict": 0,
            "source_ref": f"generator v{GEN_VERSION}",
        }])
        lib.update_analysis(
            score_id,
            file_path=path.relative_to(lib.data_dir).as_posix(),
            key=a.key,
            time_signature=a.time_signature,
            seconds=a.seconds,
            n_notes=a.n_notes,
            piano_only=a.piano_only,
            difficulty=score_difficulty(a, None),
        )
        ids.append(score_id)
        if progress:
            progress("Making exercises", i + 1, len(exercises), "items")
    return ids


class GenSource(Source):
    name = "gen"
    label = "Generated exercises"
    description = "Beginner exercises and short pieces made by the coach"
    keeps_catalogue_row = False

    def sync(self, lib, from_file):
        if from_file is not None:
            raise UnsupportedCommand("gen makes its exercises itself; --from is not used")
        n = len(generate(lib))
        print(f"Generated {n} exercises in {files_dir(lib.data_dir, 'gen')}")
        return n

    def setup_steps(self, lib):
        done = True
        exercises = all_exercises()
        for ex in exercises:
            row = lib.get("gen:" + ex.key)
            if not row or not row["file_path"] or not (lib.data_dir / row["file_path"]).exists():
                done = False
                break
        return [SetupStep("exercises", "Beginner exercises", f"Makes {len(exercises)} short practice pieces for the skill tree",
                          "the skill tree drills", done)]

    def run_setup_step(self, lib, step_id, progress=None):
        if step_id != "exercises":
            raise LookupError(f"no setup step '{step_id}'")
        ids = generate(lib, progress)
        return f"Made {len(ids)} exercises"

    def search(self, lib, text, *, difficulty=None, key=None, time_signature=None, limit=50):
        return []

    def download(self, lib, ids, progress=None):
        for i in ids:
            print(f"{i} is a generated exercise; make them with: coach scores sync gen")
        return []
