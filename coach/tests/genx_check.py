import re
import xml.etree.ElementTree as ET

from rusty_piano_coach import compare
from rusty_piano_coach.library.analyse import analyse_file

_SEMI = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_KEY = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)+$")


def written_pitches(ex):
    root = ET.fromstring(ex.musicxml().split("\n", 1)[1])
    out = []
    for p in root.iter("pitch"):
        alter = p.find("alter")
        out.append(12 * (int(p.find("octave").text) + 1) + _SEMI[p.find("step").text]
                   + (int(alter.text) if alter is not None else 0))
    return out


def count_notes(sc, hands):
    return len(compare.expected_notes(sc, hands=hands)[0])


def check_exercises(exercises, tmp_dir, *, track, nodes, per_node=(4, 6)):
    keys = [e.key for e in exercises]
    assert len(keys) == len(set(keys)), f"duplicate keys in {track}"
    counts = {n: 0 for n in nodes}
    loaded = {}
    for ex in exercises:
        k = ex.key
        assert _KEY.match(k), f"{k}: bad key"
        if ex.node.startswith("piece-"):
            assert k == ex.node, f"{k}: key must equal node {ex.node}"
        else:
            assert k.startswith(ex.node.lower() + "-"), f"{k}: key must start with node"
            assert ex.title.startswith(ex.node + " "), f"{k}: title must start with node"
        assert ex.track == track, f"{k}: track {ex.track} != {track}"
        assert ex.node in nodes, f"{k}: node {ex.node} not in nodes"
        counts[ex.node] += 1
        if ex.hands == "right":
            assert ex.rh != "" and not (ex.lh or ex.lh2), f"{k}: right hand only"
        elif ex.hands == "left":
            assert ex.lh != "" and not (ex.rh or ex.rh2), f"{k}: left hand only"
        else:
            assert ex.hands == "both" and (ex.rh or ex.rh2 or ex.lh or ex.lh2), f"{k}: both hands need notes"
        assert ex.mode in ("wait", "live"), f"{k}: bad mode"
        assert 40 <= ex.bpm <= 120, f"{k}: bpm out of range"
        assert ex.goal, f"{k}: empty goal"
        assert ex.time in ("2/4", "3/4", "4/4", "6/8", "2/2"), f"{k}: bad time"
        assert -4 <= ex.fifths <= 4, f"{k}: bad fifths"
        text = ex.musicxml()
        assert text == ex.musicxml(), f"{k}: not deterministic"
        ET.fromstring(text.split("\n", 1)[1])
        pitches = written_pitches(ex)
        assert len(pitches) >= 4, f"{k}: fewer than 4 pitches"
        assert all(36 <= p <= 84 for p in pitches), f"{k}: pitch outside 36..84"
        path = tmp_dir / f"{k}.musicxml"
        path.write_text(text, encoding="utf-8")
        a = analyse_file(path)
        assert a.time_signature == ex.time, f"{k}: time signature {a.time_signature}"
        assert a.n_notes > 0, f"{k}: no notes"
        sc = compare.load_score(path)
        r, l = count_notes(sc, "right"), count_notes(sc, "left")
        if ex.hands == "right":
            assert r > 0 and l == 0, f"{k}: right hand counts {r}/{l}"
        elif ex.hands == "left":
            assert l > 0 and r == 0, f"{k}: left hand counts {r}/{l}"
        else:
            assert r + l > 0, f"{k}: no notes in either hand"
        loaded[k] = sc
    for n, c in counts.items():
        assert per_node[0] <= c <= per_node[1], f"{n}: {c} exercises, need {per_node[0]}..{per_node[1]}"
    return loaded
