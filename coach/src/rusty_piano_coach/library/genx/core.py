"""Richer exercise notation and MusicXML writer for generated exercises.

Notation (genx voice text): rh is the right hand on the treble staff, lh the
left hand on the bass staff; '' means that hand rests throughout. Bars are
separated by ' | ' and tokens by spaces.

- Note: PITCH[:DUR][FLAGS]. PITCH = letter A-G, optional '#' (sharp) or 'b'
  (flat), octave digit; this is the sounding pitch (C4 = middle C).
- Chord: pitches joined by '+', e.g. C3+E3+G3:h.
- DUR: w, h, q (the default), e; a '.' right after it makes it dotted
  (h., q., e.); 3e = triplet eighth.
- Rest: r:DUR; a bare 'r' = whole-bar rest.
- FLAGS: '~' tie into the next note, '!' staccato, '(' slur start, ')' slur
  end, '@1'..'@5' fingering.
- Direction words, applied to the next note of the same voice (or written at
  the bar end if no note follows in that bar): pp p mp mf f ff cresc dim end
  ped pedup pedchange.

Divisions are 12 per quarter: w 48, h 24, q 12, e 6, h. 36, q. 18, e. 9, 3e 4.
Gx holds one exercise; write(ex) gives its MusicXML; walk() and bars() build
random-walk melodies; drill() gives the skill tree drill row.
"""

import random
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass

DIVISIONS = 12

_DUR = {"w": 48, "h": 24, "q": 12, "e": 6, "h.": 36, "q.": 18, "e.": 9, "3e": 4}
_TYPE = {"w": "whole", "h": "half", "q": "quarter", "e": "eighth"}
_BAR = {"2/4": 24, "3/4": 36, "4/4": 48}
_SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_KEY_ALTERS = {0: {}, 1: {"F": 1}, -1: {"B": -1}}
_DYNAMICS = ("pp", "p", "mp", "mf", "f", "ff")
_WORDS = _DYNAMICS + ("cresc", "dim", "end", "ped", "pedup", "pedchange")
_TOKEN = re.compile(
    r"^(r|[A-G][#b]?[0-8](?:\+[A-G][#b]?[0-8])*)(?::(3e|[whqe]\.?))?((?:[~!()]|@[1-5])*)$"
)
_PITCH = re.compile(r"^([A-G])([#b]?)([0-8])$")


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
    bars = []
    slur = False
    hairpin = False
    pedal = False
    for bi, chunk in enumerate(text.split("|"), start=1):
        events = []
        pending = []
        offset = 0

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
            if not m:
                raise err(f"has unknown token '{tok}'")
            pitch_text, dur, flags = m.group(1), m.group(2), m.group(3)
            ev = {"dirs": pending, "offset": offset, "bar": bi, "dur_name": dur}
            pending = []
            if pitch_text == "r":
                if dur is None:
                    if flags:
                        raise err(f"has rest '{tok}' with flags")
                    ev.update(rest=True, bare=True, dur=barlen, dur_name="w")
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
                ev["dur_name"] = dur
                ev["dur"] = _DUR[dur]
            ev["tie"] = "~" in flags
            ev["stac"] = "!" in flags
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
        if offset != barlen:
            raise err(f"has {_beats(offset)} beats, needs {_beats(barlen)}")
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
                and ev["dur_name"] in ("e", "e.", "3e")
                and ev["offset"] // 12 == (ev["offset"] + ev["dur"] - 1) // 12
            )
            if beamable and run and run[-1]["offset"] // 12 == ev["offset"] // 12:
                run.append(ev)
                continue
            runs.append(run)
            run = [ev] if beamable else []
        runs.append(run)
        for run in runs:
            if len(run) >= 2:
                for k, r in enumerate(run):
                    r["beam"] = "begin" if k == 0 else "end" if k == len(run) - 1 else "continue"
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


def _note_els(measure, ev, staff, voice_no, alters):
    pitches = [None] if ev["rest"] else ev["pitches"]
    for idx, ptext in enumerate(pitches):
        first = idx == 0
        n = ET.SubElement(measure, "note")
        if idx:
            ET.SubElement(n, "chord")
        if ev["rest"]:
            ET.SubElement(n, "rest", {"measure": "yes"} if ev["bare"] else {})
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
        if not ev["bare"]:
            _text(n, "type", _TYPE["e" if name == "3e" else name[0]])
        if name.endswith("."):
            ET.SubElement(n, "dot")
        if not ev["rest"] and alter != alters.get(step, 0):
            _text(n, "accidental", "sharp" if alter > 0 else "flat" if alter < 0 else "natural")
        if ev.get("triplet"):
            tm = ET.SubElement(n, "time-modification")
            _text(tm, "actual-notes", 3)
            _text(tm, "normal-notes", 2)
        _text(n, "staff", staff)
        if first and ev.get("beam"):
            _text(n, "beam", ev["beam"]).set("number", "1")
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
        if ev["stac"]:
            ET.SubElement(ET.SubElement(notations, "articulations"), "staccato")
        if first and ev["finger"]:
            _text(ET.SubElement(notations, "technical"), "fingering", ev["finger"])
        if len(notations):
            n.append(notations)


def _check(ex):
    if ex.time not in _BAR:
        raise ValueError(f"{ex.key}: time {ex.time} is not 2/4, 3/4 or 4/4")
    if ex.fifths not in _KEY_ALTERS:
        raise ValueError(f"{ex.key}: fifths {ex.fifths} must be -1, 0 or 1")
    if ex.hands not in ("right", "left", "both"):
        raise ValueError(f"{ex.key}: hands {ex.hands} must be right, left or both")
    if ex.mode not in ("wait", "live"):
        raise ValueError(f"{ex.key}: mode {ex.mode} must be wait or live")


def write(ex) -> str:
    _check(ex)
    barlen = _BAR[ex.time]
    voices = [_parse_voice(ex, "rh", ex.rh, barlen), _parse_voice(ex, "lh", ex.lh, barlen)]
    if not voices[0] and not voices[1]:
        raise ValueError(f"{ex.key}: both hands are empty")
    if voices[0] and voices[1] and len(voices[0]) != len(voices[1]):
        raise ValueError(f"{ex.key}: rh has {len(voices[0])} bars but lh has {len(voices[1])}")
    nbars = len(voices[0] or voices[1])
    alters = _KEY_ALTERS[ex.fifths]
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
    for i in range(nbars):
        m = ET.SubElement(part, "measure", {"number": str(i + 1)})
        if i == 0:
            attrs = ET.SubElement(m, "attributes")
            _text(attrs, "divisions", DIVISIONS)
            k = ET.SubElement(attrs, "key")
            _text(k, "fifths", ex.fifths)
            t = ET.SubElement(attrs, "time")
            _text(t, "beats", beats)
            _text(t, "beat-type", beat_type)
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
                _text(b, "duration", barlen)
            voice = voices[staff - 1]
            if not voice:
                rest = {"rest": True, "bare": True, "dur": barlen, "dur_name": "w", "tie": False,
                        "tie_stop": False, "stac": False, "slur_start": False, "slur_stop": False,
                        "finger": None, "dirs": []}
                _note_els(m, rest, staff, staff, alters)
                continue
            events, trailing = voice[i]
            for ev in events:
                for w in ev["dirs"]:
                    _direction(m, w, staff)
                _note_els(m, ev, staff, staff, alters)
            for w in trailing:
                _direction(m, w, staff)
        if i == nbars - 1:
            bl = ET.SubElement(m, "barline", {"location": "right"})
            _text(bl, "bar-style", "light-heavy")
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
        "tempo": 100,
        "loop": False,
        "bars": None,
        "goal": ex.goal,
    }
    d.update(override)
    return d
