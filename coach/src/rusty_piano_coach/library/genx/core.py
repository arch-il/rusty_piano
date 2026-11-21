"""Richer exercise notation and MusicXML writer for generated exercises.

Notation (genx voice text): rh is the right hand on the treble staff, lh the
left hand on the bass staff; '' means that hand rests throughout. Bars are
separated by ' | ' and tokens by spaces.

- Note: PITCH[:DUR][FLAGS]. PITCH = letter A-G, optional '#' (sharp) or 'b'
  (flat), octave digit; this is the sounding pitch (C4 = middle C).
- Chord: pitches joined by '+', e.g. C3+E3+G3:h.
- DUR: w, h, q (the default), e; a '.' right after it makes it dotted
  (h., q., e.); 3e = triplet eighth; s = sixteenth (never dotted).
- Rest: r:DUR; a bare 'r' = whole-bar rest.
- FLAGS: '~' tie into the next note, '!' staccato, '(' slur start, ')' slur
  end, '>' accent, '@1'..'@5' fingering.
- Direction words, applied to the next note of the same voice (or written at
  the bar end if no note follows in that bar): pp p mp mf f ff cresc dim end
  ped pedup pedchange; also 'treble' and 'bass', a clef change on the voice's
  staff before that note (written only if it differs from the current clef).

Divisions are 12 per quarter: w 48, h 24, q 12, e 6, h. 36, q. 18, e. 9, 3e 4.
Gx holds one exercise; write(ex) gives its MusicXML; walk() and bars() build
random-walk melodies; drill() gives the skill tree drill row.
"""

import random
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass

DIVISIONS = 12

_DUR = {"w": 48, "h": 24, "q": 12, "e": 6, "h.": 36, "q.": 18, "e.": 9, "3e": 4, "s": 3}
_TYPE = {"w": "whole", "h": "half", "q": "quarter", "e": "eighth", "s": "16th"}
_BAR = {"2/4": 24, "3/4": 36, "4/4": 48, "6/8": 36, "2/2": 48}
_SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_KEY_ALTERS = {
    n: ({s: 1 for s in "FCGDAEB"[:n]} if n >= 0 else {s: -1 for s in "BEADGCF"[:-n]})
    for n in range(-7, 8)
}
_DYNAMICS = ("pp", "p", "mp", "mf", "f", "ff")
_WORDS = _DYNAMICS + ("treble", "bass", "cresc", "dim", "end", "ped", "pedup", "pedchange")
_CLEFS = {"treble": ("G", 2), "bass": ("F", 4)}
_TOKEN = re.compile(
    r"^(r|[A-G][#b]?[0-8](?:\+[A-G][#b]?[0-8])*)(?::(3e|s|[whqe]\.?))?((?:[~!>()]|@[1-5])*)$"
)
_PITCH = re.compile(r"^([A-G])([#b]?)([0-8])$")
_MARKS = ("repeat-start", "repeat-end", "ending-1", "ending-2", "fine", "dc-al-fine", "segno", "to-coda", "coda",
          "ds-al-coda")
_SYMBOL = re.compile(r"^([A-G])([#b]?)(maj7|m7b5|dim7|dim|aug|m7|m|7)?(?:/([A-G])([#b]?))?$")
_KINDS = {"": "major", "m": "minor", "7": "dominant", "maj7": "major-seventh", "m7": "minor-seventh",
          "dim": "diminished", "aug": "augmented", "m7b5": "half-diminished", "dim7": "diminished-seventh"}
_END_DIRS = {
    "fine": ("below", "Fine", {"fine": "yes"}),
    "dc-al-fine": ("above", "D.C. al Fine", {"dacapo": "yes"}),
    "to-coda": ("above", "To Coda", {"tocoda": "coda"}),
    "ds-al-coda": ("above", "D.S. al Coda", {"dalsegno": "segno"}),
}


@dataclass(frozen=True)
class Gx:
    key: str
    title: str
    node: str
    track: str
    bpm: int
    rh: str = ""
    lh: str = ""
    time: str = "4/4"
    fifths: int = 0
    hands: str = "right"
    mode: str = "wait"
    goal: str = ""
    drill_title: str = ""
    composer: str = "rusty_piano exercises"
    pickup: int = 0
    drill_tempo: int = 100
    loop: bool = False
    ramp: bool = False
    target: int = 0
    rh2: str = ""
    lh2: str = ""
    marks: str = ""
    symbols: str = ""

    @property
    def tags(self):
        if self.node.startswith("piece-"):
            return "piece beginner"
        return f"exercise beginner {self.node.lower()} {self.track}"

    def musicxml(self) -> str:
        return write(self)


def _beats(n):
    return f"{n / 12:g}"


def _parse_voice(ex, voice, text, barlen):
    """Return a list of bars; each bar is (events, trailing_directions)."""
    key = ex.key
    if not text.strip():
        return []
    first_len = ex.pickup if 0 < ex.pickup < barlen else barlen
    grp_len = 18 if ex.time == "6/8" else 12
    bars = []
    slur = False
    hairpin = False
    pedal = False
    for bi, chunk in enumerate(text.split("|"), start=1):
        events = []
        pending = []
        offset = 0
        blen = first_len if bi == 1 else barlen

        def err(msg, bi=bi):
            return ValueError(f"{key}: {voice} bar {bi} {msg}")

        for tok in chunk.split():
            if tok in _WORDS:
                if tok in ("cresc", "dim"):
                    if hairpin:
                        raise err(f"has '{tok}' while a hairpin is open")
                    hairpin = True
                elif tok == "end":
                    if not hairpin:
                        raise err("has 'end' with no hairpin open")
                    hairpin = False
                elif tok == "ped":
                    if pedal:
                        raise err("has 'ped' while the pedal is down")
                    pedal = True
                elif tok in ("pedup", "pedchange"):
                    if not pedal:
                        raise err(f"has '{tok}' while the pedal is up")
                    if tok == "pedup":
                        pedal = False
                pending.append(tok)
                continue
            m = _TOKEN.match(tok)
            if not m and "^" in tok:
                raise err(f"has '{tok}'; the '^' flag is gone, put the 'treble' clef word before the note instead")
            if not m:
                raise err(f"has unknown token '{tok}'")
            pitch_text, dur, flags = m.group(1), m.group(2), m.group(3)
            ev = {"dirs": pending, "offset": offset, "bar": bi, "dur_name": dur}
            pending = []
            if pitch_text == "r":
                if dur is None:
                    if flags:
                        raise err(f"has rest '{tok}' with flags")
                    ev.update(rest=True, bare=True, dur=blen, dur_name=_bare_name(blen, barlen))
                else:
                    if flags:
                        raise err(f"has rest '{tok}' with flags")
                    ev.update(rest=True, bare=False)
            else:
                ev.update(rest=False, bare=False)
                ev["pitches"] = pitch_text.split("+")
            if not ev.get("bare"):
                dur = dur or "q"
                if dur not in _DUR:
                    raise err(f"has unknown duration in '{tok}'")
                if dur == "3e" and ex.time == "6/8":
                    raise err(f"has triplet '{tok}' in 6/8")
                ev["dur_name"] = dur
                ev["dur"] = _DUR[dur]
            ev["tie"] = "~" in flags
            ev["stac"] = "!" in flags
            ev["accent"] = ">" in flags
            ev["slur_start"] = "(" in flags
            ev["slur_stop"] = ")" in flags
            f = re.search(r"@([1-5])", flags)
            ev["finger"] = f.group(1) if f else None
            if ev["slur_start"] and ev["slur_stop"]:
                raise err(f"has '(' and ')' on the same note '{tok}'")
            if ev["slur_start"]:
                if slur:
                    raise err("starts a slur while one is open")
                slur = True
            if ev["slur_stop"]:
                if not slur:
                    raise err("ends a slur with none open")
                slur = False
            offset += ev["dur"]
            events.append(ev)
        if any(w in _CLEFS for w in pending):
            raise err("has a clef word with no note after it")
        if offset != blen:
            raise err(f"has {_beats(offset)} beats, needs {_beats(blen)}")
        bars.append((events, pending))
    if slur:
        raise ValueError(f"{key}: {voice} has a slur that is never closed")
    if hairpin:
        raise ValueError(f"{key}: {voice} has a hairpin that is never closed")
    if pedal:
        raise ValueError(f"{key}: {voice} leaves the pedal down at the end")
    flat = [ev for events, _ in bars for ev in events]
    for i, ev in enumerate(flat):
        if ev["tie"]:
            nxt = flat[i + 1] if i + 1 < len(flat) else None
            if nxt is None:
                raise ValueError(f"{key}: {voice} bar {ev['bar']} has a tie on the last note")
            if nxt["rest"] or set(nxt["pitches"]) != set(ev["pitches"]):
                raise ValueError(f"{key}: {voice} bar {ev['bar']} has a tie to a different note")
    i = 0
    while i < len(flat):
        if flat[i]["dur_name"] != "3e":
            i += 1
            continue
        j = i
        while j < len(flat) and flat[j]["dur_name"] == "3e":
            j += 1
        if (j - i) % 3:
            raise ValueError(f"{key}: {voice} bar {flat[i]['bar']} has a triplet group that is not 3 notes")
        for g in range(i, j, 3):
            grp = flat[g:g + 3]
            if grp[0]["offset"] % 12:
                raise ValueError(f"{key}: {voice} bar {grp[0]['bar']} has a triplet not starting on a beat")
            if len({e["bar"] for e in grp}) != 1:
                raise ValueError(f"{key}: {voice} bar {grp[0]['bar']} has a triplet crossing the bar line")
            grp[0]["tuplet"] = "start"
            grp[2]["tuplet"] = "stop"
            for e in grp:
                e["triplet"] = True
        i = j
    prev_tie = False
    for ev in flat:
        ev["tie_stop"] = prev_tie
        prev_tie = ev["tie"]
    for events, _ in bars:
        runs = []
        run = []
        for ev in events:
            beamable = (
                not ev["rest"]
                and ev["dur_name"] in ("e", "e.", "3e", "s")
                and ev["offset"] // grp_len == (ev["offset"] + ev["dur"] - 1) // grp_len
            )
            if beamable and run and run[-1]["offset"] // grp_len == ev["offset"] // grp_len:
                run.append(ev)
                continue
            runs.append(run)
            run = [ev] if beamable else []
        runs.append(run)
        for run in runs:
            if len(run) >= 2:
                for k, r in enumerate(run):
                    r["beam"] = "begin" if k == 0 else "end" if k == len(run) - 1 else "continue"
                k = 0
                while k < len(run):
                    if run[k]["dur_name"] != "s":
                        k += 1
                        continue
                    j = k
                    while j < len(run) and run[j]["dur_name"] == "s":
                        j += 1
                    if j - k >= 2:
                        for q in range(k, j):
                            run[q]["beam2"] = "begin" if q == k else "end" if q == j - 1 else "continue"
                    else:
                        run[k]["beam2"] = "backward hook" if k > 0 else "forward hook"
                    k = j
    return bars


def _text(parent, tag, text):
    e = ET.SubElement(parent, tag)
    e.text = str(text)
    return e


def _direction(measure, word, staff):
    d = ET.SubElement(measure, "direction", {"placement": "below"})
    dt = ET.SubElement(d, "direction-type")
    if word in _DYNAMICS:
        ET.SubElement(ET.SubElement(dt, "dynamics"), word)
    elif word == "cresc":
        ET.SubElement(dt, "wedge", {"type": "crescendo"})
    elif word == "dim":
        ET.SubElement(dt, "wedge", {"type": "diminuendo"})
    elif word == "end":
        ET.SubElement(dt, "wedge", {"type": "stop"})
    elif word == "ped":
        ET.SubElement(dt, "pedal", {"type": "start", "line": "yes"})
    elif word == "pedup":
        ET.SubElement(dt, "pedal", {"type": "stop", "line": "yes"})
    else:
        ET.SubElement(dt, "pedal", {"type": "change", "line": "yes"})
    _text(d, "staff", staff)


def _bare_name(dur, barlen):
    if dur == barlen:
        return "w"
    return next((k for k, v in _DUR.items() if v == dur and k != "3e"), "w")


def _note_els(measure, ev, staff, voice_no, alters, state, stem=None):
    pitches = [None] if ev["rest"] else ev["pitches"]
    for idx, ptext in enumerate(pitches):
        first = idx == 0
        n = ET.SubElement(measure, "note")
        if idx:
            ET.SubElement(n, "chord")
        if ev["rest"]:
            full = ev["bare"] and ev["dur_name"] == "w"
            ET.SubElement(n, "rest", {"measure": "yes"} if full else {})
            alter = 0
        else:
            step, acc, octave = _PITCH.match(ptext).groups()
            alter = {"#": 1, "b": -1}.get(acc, 0)
            p = ET.SubElement(n, "pitch")
            _text(p, "step", step)
            if alter:
                _text(p, "alter", alter)
            _text(p, "octave", octave)
        _text(n, "duration", ev["dur"])
        if ev["tie_stop"]:
            ET.SubElement(n, "tie", {"type": "stop"})
        if ev["tie"]:
            ET.SubElement(n, "tie", {"type": "start"})
        _text(n, "voice", voice_no)
        name = ev["dur_name"]
        if not ev["bare"] or ev["dur_name"] != "w":
            _text(n, "type", _TYPE["e" if name == "3e" else name[0]])
        if name.endswith("."):
            ET.SubElement(n, "dot")
        if not ev["rest"] and not ev["tie_stop"]:
            cur = state.get((step, octave), alters.get(step, 0))
            if alter != cur:
                _text(n, "accidental", "sharp" if alter > 0 else "flat" if alter < 0 else "natural")
            state[(step, octave)] = alter
        if ev.get("triplet"):
            tm = ET.SubElement(n, "time-modification")
            _text(tm, "actual-notes", 3)
            _text(tm, "normal-notes", 2)
        if stem and not ev["rest"]:
            _text(n, "stem", stem)
        _text(n, "staff", staff)
        if first and ev.get("beam"):
            _text(n, "beam", ev["beam"]).set("number", "1")
            if ev.get("beam2"):
                _text(n, "beam", ev["beam2"]).set("number", "2")
        notations = ET.Element("notations")
        if ev["tie_stop"]:
            ET.SubElement(notations, "tied", {"type": "stop"})
        if ev["tie"]:
            ET.SubElement(notations, "tied", {"type": "start"})
        if first and ev["slur_start"]:
            ET.SubElement(notations, "slur", {"type": "start", "number": "1"})
        if first and ev["slur_stop"]:
            ET.SubElement(notations, "slur", {"type": "stop", "number": "1"})
        if first and ev.get("tuplet"):
            ET.SubElement(notations, "tuplet", {"type": ev["tuplet"]})
        if ev["stac"] or ev.get("accent"):
            arts = ET.SubElement(notations, "articulations")
            if ev.get("accent"):
                ET.SubElement(arts, "accent")
            if ev["stac"]:
                ET.SubElement(arts, "staccato")
        if first and ev["finger"]:
            fattr = {"placement": "above"} if stem == "up" else {"placement": "below"} if stem == "down" else {}
            _text(ET.SubElement(notations, "technical"), "fingering", ev["finger"]).attrib.update(fattr)
        if len(notations):
            n.append(notations)


def _check(ex):
    if ex.time == "6/8" and ex.bpm % 3:
        raise ValueError(f"{ex.key}: bpm {ex.bpm} in 6/8 must be a multiple of 3 (the mark is dotted quarter = bpm * 2 / 3)")
    if ex.time == "2/2" and ex.bpm % 2:
        raise ValueError(f"{ex.key}: bpm {ex.bpm} in cut time must be even (the mark is half = bpm / 2)")
    if ex.time not in _BAR:
        raise ValueError(f"{ex.key}: time {ex.time} is not 2/4, 3/4, 4/4, 6/8 or 2/2")
    if ex.fifths not in _KEY_ALTERS:
        raise ValueError(f"{ex.key}: fifths {ex.fifths} must be -7 to 7")
    if not 20 <= ex.drill_tempo <= 150:
        raise ValueError(f"{ex.key}: drill_tempo {ex.drill_tempo} must be 20 to 150")
    if ex.ramp and not (ex.loop and 1 <= ex.target <= 300):
        raise ValueError(f"{ex.key}: ramp needs loop true and a target of 1 to 300")
    if ex.hands not in ("right", "left", "both"):
        raise ValueError(f"{ex.key}: hands {ex.hands} must be right, left or both")
    if ex.mode not in ("wait", "live"):
        raise ValueError(f"{ex.key}: mode {ex.mode} must be wait or live")
    if ex.pickup > 0 and ex.pickup not in {v for k, v in _DUR.items() if k != "3e"}:
        raise ValueError(f"{ex.key}: pickup {ex.pickup} is not a single note length")


def _parse_marks(ex, nbars):
    marks = {}
    for tok in ex.marks.split():
        bar_text, _, mark = tok.partition(":")
        if mark not in _MARKS or not bar_text.isdigit() or not 1 <= int(bar_text) <= nbars:
            raise ValueError(f"{ex.key}: bad mark '{tok}'")
        marks.setdefault(int(bar_text), []).append(mark)
    return marks


def _parse_symbols(ex, nbars):
    out = {}
    for tok in ex.symbols.split():
        pos, _, sym = tok.partition(":")
        m = re.match(r"^(\d+)(?:\.(\d+))?$", pos)
        sm = _SYMBOL.match(sym)
        if not m or not sm or int(m.group(1)) > nbars or int(m.group(1)) < 1 or int(m.group(2) or 1) < 1:
            raise ValueError(f"{ex.key}: bad symbol '{tok}'")
        out[(int(m.group(1)), (int(m.group(2) or 1) - 1) * 12)] = sm.groups()
    return out


def _harmony(measure, sym):
    root, ralter, suffix, bass, balter = sym
    h = ET.SubElement(measure, "harmony")
    r = ET.SubElement(h, "root")
    _text(r, "root-step", root)
    if ralter:
        _text(r, "root-alter", 1 if ralter == "#" else -1)
    _text(h, "kind", _KINDS[suffix or ""]).set("text", suffix or "")
    if bass:
        b = ET.SubElement(h, "bass")
        _text(b, "bass-step", bass)
        if balter:
            _text(b, "bass-alter", 1 if balter == "#" else -1)


def _words_direction(measure, placement, words, sound):
    d = ET.SubElement(measure, "direction", {"placement": placement})
    _text(ET.SubElement(d, "direction-type"), "words", words)
    ET.SubElement(d, "sound", sound)


def _barline(measure, location, items):
    bl = ET.SubElement(measure, "barline", {"location": location})
    for it in items:
        if it[0] == "bar-style":
            _text(bl, "bar-style", it[1])
        elif it[0] == "ending":
            e = ET.SubElement(bl, "ending", it[1])
            if it[2]:
                e.text = it[2]
        else:
            ET.SubElement(bl, "repeat", it[1])


def _tempo(measure, ex):
    bpm = ex.bpm
    if ex.time in ("6/8", "2/2"):
        d = ET.SubElement(measure, "direction", {"placement": "above"})
        met = ET.SubElement(ET.SubElement(d, "direction-type"), "metronome")
        if ex.time == "6/8":
            _text(met, "beat-unit", "quarter")
            ET.SubElement(met, "beat-unit-dot")
            _text(met, "per-minute", bpm * 2 // 3)
        else:
            _text(met, "beat-unit", "half")
            _text(met, "per-minute", bpm // 2)
        _text(d, "staff", 1)
        # Hidden quarter mark last: OSMD sets the tempo from the last metronome it reads
        # (ignoring beat-unit half), so this keeps the page at quarter = bpm.
        d = ET.SubElement(measure, "direction", {"placement": "above"})
        met = ET.SubElement(ET.SubElement(d, "direction-type"), "metronome", {"print-object": "no"})
        _text(met, "beat-unit", "quarter")
        _text(met, "per-minute", bpm)
        _text(d, "staff", 1)
        ET.SubElement(d, "sound", {"tempo": str(bpm)})
        return
    d = ET.SubElement(measure, "direction", {"placement": "above"})
    dt = ET.SubElement(d, "direction-type")
    met = ET.SubElement(dt, "metronome")
    _text(met, "beat-unit", "quarter")
    _text(met, "per-minute", bpm)
    _text(d, "staff", 1)
    ET.SubElement(d, "sound", {"tempo": str(bpm)})


def write(ex) -> str:
    _check(ex)
    barlen = _BAR[ex.time]
    voices = [_parse_voice(ex, "rh", ex.rh, barlen), _parse_voice(ex, "lh", ex.lh, barlen)]
    if not voices[0] and not voices[1]:
        raise ValueError(f"{ex.key}: both hands are empty")
    if voices[0] and voices[1] and len(voices[0]) != len(voices[1]):
        raise ValueError(f"{ex.key}: rh has {len(voices[0])} bars but lh has {len(voices[1])}")
    nbars = len(voices[0] or voices[1])
    rh2 = _parse_voice(ex, "rh2", ex.rh2, barlen)
    lh2 = _parse_voice(ex, "lh2", ex.lh2, barlen)
    if rh2 and not voices[0]:
        raise ValueError(f"{ex.key}: rh2 needs rh")
    if lh2 and not voices[1]:
        raise ValueError(f"{ex.key}: lh2 needs lh")
    if rh2 and len(rh2) != nbars:
        raise ValueError(f"{ex.key}: rh2 has {len(rh2)} bars but needs {nbars}")
    if lh2 and len(lh2) != nbars:
        raise ValueError(f"{ex.key}: lh2 has {len(lh2)} bars but needs {nbars}")
    marks = _parse_marks(ex, nbars)
    symbols = _parse_symbols(ex, nbars)
    harm_voice = voices[0] or voices[1]
    for (bar, off), _ in symbols.items():
        if not any(ev["offset"] == off for ev in harm_voice[bar - 1][0]):
            raise ValueError(f"{ex.key}: symbol at bar {bar} offset {off} has no note starting there")
    plan = ((1, 1, voices[0], rh2), (2, 2, voices[1], lh2))
    alters = _KEY_ALTERS[ex.fifths]
    first_len = ex.pickup if 0 < ex.pickup < barlen else barlen
    beats, beat_type = ex.time.split("/")

    root = ET.Element("score-partwise", {"version": "4.0"})
    work = ET.SubElement(root, "work")
    _text(work, "work-title", ex.title)
    ident = ET.SubElement(root, "identification")
    c = _text(ident, "creator", ex.composer)
    c.set("type", "composer")
    plist = ET.SubElement(root, "part-list")
    sp = ET.SubElement(plist, "score-part", {"id": "P1"})
    _text(sp, "part-name", "Piano")
    inst = ET.SubElement(sp, "midi-instrument", {"id": "P1-I1"})
    _text(inst, "midi-program", 1)
    part = ET.SubElement(root, "part", {"id": "P1"})
    clef_now = {1: "treble", 2: "bass"}
    for i in range(nbars):
        m = ET.SubElement(part, "measure", {"number": str(i + 1)})
        if i == 0 and first_len != barlen:
            m.set("implicit", "yes")
        if i == 0:
            attrs = ET.SubElement(m, "attributes")
            _text(attrs, "divisions", DIVISIONS)
            k = ET.SubElement(attrs, "key")
            _text(k, "fifths", ex.fifths)
            t = ET.SubElement(attrs, "time", {"symbol": "cut"} if ex.time == "2/2" else {})
            _text(t, "beats", beats)
            _text(t, "beat-type", beat_type)
            _text(attrs, "staves", 2)
            for num, sign, line in ((1, "G", 2), (2, "F", 4)):
                clef = ET.SubElement(attrs, "clef", {"number": str(num)})
                _text(clef, "sign", sign)
                _text(clef, "line", line)
        blen = first_len if i == 0 else barlen
        mk = marks.get(i + 1, [])
        left = []
        if "repeat-start" in mk:
            left.append(("bar-style", "heavy-light"))
        for n in (1, 2):
            if f"ending-{n}" in mk:
                left.append(("ending", {"number": str(n), "type": "start"}, f"{n}."))
        if "repeat-start" in mk:
            left.append(("repeat", {"direction": "forward"}))
        if left:
            _barline(m, "left", left)
        if i == 0:
            _tempo(m, ex)
        for mark, word in (("segno", "segno"), ("coda", "coda")):
            if mark in mk:
                d = ET.SubElement(m, "direction", {"placement": "above"})
                ET.SubElement(ET.SubElement(d, "direction-type"), word)
                ET.SubElement(d, "sound", {word: word})
        states = {1: {}, 2: {}}
        for staff, voice_no, voice, second in plan:
            if staff == 2:
                b = ET.SubElement(m, "backup")
                _text(b, "duration", blen)
            if not voice:
                rest = {"rest": True, "bare": True, "dur": blen, "dur_name": _bare_name(blen, barlen), "tie": False,
                        "tie_stop": False, "stac": False, "slur_start": False, "slur_stop": False,
                        "finger": None, "dirs": []}
                _note_els(m, rest, staff, staff, alters, states[staff])
                continue
            two = bool(second)
            harm_here = voice is harm_voice
            for vn, vc, stem in ((staff, voice, "up" if two else None), (staff + 2, second, "down")):
                if not vc:
                    continue
                if vn != staff:
                    b = ET.SubElement(m, "backup")
                    _text(b, "duration", blen)
                events, trailing = vc[i]
                for ev in events:
                    for w in ev["dirs"]:
                        if w not in _CLEFS:
                            _direction(m, w, staff)
                    for w in ev["dirs"]:
                        if w in _CLEFS and clef_now[staff] != w:
                            clef_now[staff] = w
                            sign, line = _CLEFS[w]
                            c = ET.SubElement(ET.SubElement(m, "attributes"), "clef", {"number": str(staff)})
                            _text(c, "sign", sign)
                            _text(c, "line", line)
                    if harm_here and vn == staff and (i + 1, ev["offset"]) in symbols:
                        _harmony(m, symbols[(i + 1, ev["offset"])])
                    _note_els(m, ev, staff, vn if vn != staff else staff, alters, states[staff], stem)
                for w in trailing:
                    _direction(m, w, staff)
        for mark in mk:
            if mark in _END_DIRS:
                _words_direction(m, *_END_DIRS[mark])
        right = []
        last = i == nbars - 1
        if last or "repeat-end" in mk:
            right.append(("bar-style", "light-heavy"))
        if "ending-1" in mk:
            right.append(("ending", {"number": "1", "type": "stop"}, None))
        if "ending-2" in mk:
            right.append(("ending", {"number": "2", "type": "discontinue"}, None))
        if "repeat-end" in mk:
            right.append(("repeat", {"direction": "backward"}))
        if right:
            _barline(m, "right", right)
    ET.indent(root)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode")


def walk(seed, pitches, count, moves=(-2, -1, 1, 2), start=0):
    rnd = random.Random(seed)
    pos = start
    out = []
    for _ in range(count):
        options = [m for m in moves if 0 <= pos + m < len(pitches)]
        pos += rnd.choice(options)
        out.append(pitches[pos])
    return out


def bars(tokens, per_bar):
    if len(tokens) % per_bar:
        raise ValueError(f"{len(tokens)} tokens do not fill bars of {per_bar}")
    return " | ".join(" ".join(tokens[i:i + per_bar]) for i in range(0, len(tokens), per_bar))


def drill(ex, **override):
    d = {
        "id": ex.key.replace("-", ".", 1),
        "kind": "generated",
        "title": ex.drill_title or ex.title.removeprefix(f"{ex.node} "),
        "score": "gen:" + ex.key,
        "hands": ex.hands,
        "mode": ex.mode,
        "tempo": ex.drill_tempo,
        "loop": ex.loop,
        "bars": None,
        "goal": ex.goal,
    }
    if ex.ramp:
        d["ramp"] = True
        d["target"] = ex.target
    d.update(override)
    return d
