import json
import re
import time
import xml.etree.ElementTree as ET

import pytest

from rusty_piano_coach import compare
from rusty_piano_coach.library import scales as S
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.scales import BY_KEY, CATALOGUE, ScalesSource, generate, hand_notes, musicxml
from rusty_piano_coach.library.sources import UnsupportedCommand, all_sources, get_source
from rusty_piano_coach.server import handle_request

K = {"major": 7, "minor-natural": 7, "minor-harmonic": 7, "minor-melodic": 7, "arp-major": 3, "arp-minor": 3,
     "arp-dom7": 4, "arp-dim7": 4, "chromatic": 12}


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    d = tmp_path_factory.mktemp("scales") / "lib"
    lib = Library(d)
    src = ScalesSource()
    before = src.setup_steps(lib)[0].done
    t0 = time.perf_counter()
    msg = src.run_setup_step(lib, "scales")
    elapsed = time.perf_counter() - t0
    yield d, lib, before, msg, elapsed
    lib.close()


def nm(n):
    return n.step + ("#" * n.alter if n.alter > 0 else "b" * -n.alter) + str(n.octave)


def parse(sc):
    return ET.fromstring(musicxml(sc).split("\n", 1)[1])


def staff_notes(measure, staff):
    return [n for n in measure.findall("note") if n.findtext("staff") == staff]


def test_catalogue_size_and_keys():
    keys = [s.key for s in CATALOGUE]
    assert len(keys) == 972 and len(set(keys)) == 972
    pattern = re.compile(r"[a-z]{1,2}-(major|minor-natural|minor-harmonic|minor-melodic|arp-major|arp-minor"
                         r"|arp-dom7|arp-dim7|chromatic)-(1|2|4)oct-(rh|lh|ht)")
    for k in keys:
        assert pattern.fullmatch(k), k


def test_conventional_key_names():
    for k in ["d-minor-natural-2oct-rh", "db-major-1oct-ht", "fs-major-1oct-rh", "fs-minor-harmonic-4oct-lh",
              "cs-minor-melodic-1oct-rh", "eb-minor-natural-1oct-rh", "gs-minor-harmonic-1oct-rh",
              "bb-minor-natural-1oct-rh", "g-arp-dom7-1oct-ht", "b-arp-dim7-2oct-rh", "c-chromatic-4oct-ht"]:
        assert k in BY_KEY
    for k in ["cs-major-1oct-rh", "gb-major-1oct-rh", "db-minor-natural-1oct-rh", "ds-minor-natural-1oct-rh",
              "ab-minor-natural-1oct-rh"]:
        assert k not in BY_KEY


def test_titles_and_tags():
    sc = BY_KEY["d-minor-natural-2oct-rh"]
    assert sc.title == "D natural minor scale, 2 octaves, right hand"
    assert sc.tags == "scale scales d minor natural 2oct rh right s4"
    assert BY_KEY["c-arp-dom7-1oct-ht"].title == "C7 dominant seventh arpeggio, 1 octave, hands together"
    assert BY_KEY["db-chromatic-1oct-lh"].title == "Chromatic scale from Db, 1 octave, left hand"
    nodes = {"c-major-1oct-rh": "S1", "a-minor-melodic-1oct-lh": "S2", "e-arp-minor-1oct-rh": "S3",
             "g-major-2oct-lh": "S4", "c-major-2oct-ht": "S5", "c-major-4oct-rh": "S6", "c-chromatic-1oct-rh": "S6"}
    for k, node in nodes.items():
        assert BY_KEY[k].node == node, k


@pytest.mark.parametrize("key,hand,expected", [
    ("c-major-1oct-rh", "rh", "C4 D4 E4 F4 G4 A4 B4 C5 B4 A4 G4 F4 E4 D4 C4"),
    ("d-minor-harmonic-1oct-rh", "rh", "D4 E4 F4 G4 A4 Bb4 C#5 D5 C#5 Bb4 A4 G4 F4 E4 D4"),
    ("a-minor-melodic-1oct-rh", "rh", "A3 B3 C4 D4 E4 F#4 G#4 A4 G4 F4 E4 D4 C4 B3 A3"),
    ("gs-minor-harmonic-1oct-rh", "rh", "G#3 A#3 B3 C#4 D#4 E4 F##4 G#4 F##4 E4 D#4 C#4 B3 A#3 G#3"),
    ("c-arp-dim7-1oct-rh", "rh", "C4 Eb4 Gb4 A4 C5 A4 Gb4 Eb4 C4"),
    ("f-arp-dim7-1oct-rh", "rh", "F4 Ab4 Cb5 D5 F5 D5 Cb5 Ab4 F4"),
    ("db-arp-dom7-1oct-rh", "rh", "Db4 F4 Ab4 Cb5 Db5 Cb5 Ab4 F4 Db4"),
    ("db-chromatic-1oct-rh", "rh", "Db4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4 C5 Db5 C5 B4 Bb4 A4 Ab4 G4 Gb4 F4 E4 Eb4 D4 Db4"),
    ("c-major-1oct-lh", "lh", "C3 D3 E3 F3 G3 A3 B3 C4 B3 A3 G3 F3 E3 D3 C3"),
])
def test_spelling(key, hand, expected):
    assert " ".join(nm(n) for n in hand_notes(BY_KEY[key], hand)) == expected


def test_note_counts():
    for sc in CATALOGUE:
        hands = ["rh", "lh"] if sc.hand == "ht" else [sc.hand]
        for h in hands:
            assert len(hand_notes(sc, h)) == 2 * K[sc.kind] * sc.octaves + 1, sc.key


def test_ranges_and_octave_apart():
    for sc in CATALOGUE:
        hands = ["rh", "lh"] if sc.hand == "ht" else [sc.hand]
        for h in hands:
            for n in hand_notes(sc, h):
                assert 21 <= n.midi <= 108, sc.key
        if sc.hand == "ht":
            rh = hand_notes(sc, "rh")
            lh = hand_notes(sc, "lh")
            assert [n.midi for n in lh] == [n.midi - 12 for n in rh], sc.key
            assert [n.step for n in lh] == [n.step for n in rh], sc.key


def test_octave_shifts_c_major_4oct():
    midis = [n.midi for n in hand_notes(BY_KEY["c-major-4oct-rh"], "rh")]
    assert S.octave_shifts(midis, S.TREBLE_WINDOW) == [12] * 4 + [0] * 20 + [-12] * 9 + [0] * 20 + [12] * 4


def test_octave_shifts_c_major_4oct_lh():
    midis = [n.midi for n in hand_notes(BY_KEY["c-major-4oct-lh"], "lh")]
    assert S.octave_shifts(midis, S.BASS_WINDOW) == [0] * 21 + [-24] * 15 + [0] * 21


def test_octave_brackets_are_long_and_apart():
    for sc in CATALOGUE:
        for hand, window in (("rh", S.TREBLE_WINDOW), ("lh", S.BASS_WINDOW)):
            if sc.hand not in (hand, "ht"):
                continue
            notes = hand_notes(sc, hand)
            shifts = S.octave_shifts([n.midi for n in notes], window)
            segs = []
            for v in shifts:
                if segs and segs[-1][0] == v:
                    segs[-1][1] += 1
                else:
                    segs.append([v, 1])
            for k, (v, length) in enumerate(segs):
                if v == 0:
                    continue
                assert length >= min(S.MIN_SHIFT_RUN, len(notes)), (sc.key, hand)
                if k + 1 < len(segs):
                    assert segs[k + 1][0] == 0, (sc.key, hand)


def test_xml_c_major_4oct_ht_brackets():
    root = parse(BY_KEY["c-major-4oct-ht"])
    got = {"1": [], "2": []}
    for d in root.iter("direction"):
        oc = d.find("direction-type/octave-shift")
        if oc is not None and oc.get("type") != "stop":
            got[d.findtext("staff")].append((oc.get("type"), oc.get("size")))
    assert got["1"] == [("up", "8"), ("down", "8"), ("up", "8")]
    assert got["2"] == [("down", "15")]


def test_written_notes_fit_staff():
    windows = {"1": S.TREBLE_WINDOW, "2": S.BASS_WINDOW}
    for sc in CATALOGUE:
        root = parse(sc)
        for el in root.iter():
            assert el.tag not in ("fingering", "technical"), sc.key
        shift = {"1": 0, "2": 0}
        sounded = {"1": [], "2": []}
        for m in root.findall("part/measure"):
            for el in m:
                if el.tag == "direction":
                    oc = el.find("direction-type/octave-shift")
                    if oc is None:
                        continue
                    staff = el.findtext("staff")
                    if oc.get("type") == "stop":
                        shift[staff] = 0
                    else:
                        amount = 12 if oc.get("size") == "8" else 24
                        shift[staff] = -amount if oc.get("type") == "down" else amount
                elif el.tag == "note" and el.find("pitch") is not None:
                    staff = el.findtext("staff")
                    p = el.find("pitch")
                    alter = int(p.findtext("alter", "0"))
                    octave = int(p.findtext("octave"))
                    step = p.findtext("step")
                    midi = 12 * (octave + 1) + S.SEMI[step] + alter
                    lo, hi = windows[staff]
                    assert lo <= midi + shift[staff] <= hi, sc.key
                    sounded[staff].append((step, alter, octave, midi))
        for staff, hand in (("1", "rh"), ("2", "lh")):
            expected = [(n.step, n.alter, n.octave, n.midi) for n in hand_notes(sc, hand)] \
                if sc.hand in (hand, "ht") else []
            assert sounded[staff] == expected, sc.key


def test_xml_c_major_2oct_ht():
    root = parse(BY_KEY["c-major-2oct-ht"])
    ms = root.findall("part/measure")
    assert len(ms) == 4
    assert root.find("part/measure/attributes/divisions").text == "4"
    assert root.find("part/measure/attributes/key/fifths").text == "0"
    assert root.find("part/measure/attributes/key/mode").text == "major"
    assert root.find("part/measure/attributes/staves").text == "2"
    assert root.find("part/measure/direction/sound").get("tempo") == "80"
    for m in ms:
        assert sum(int(n.findtext("duration")) for n in staff_notes(m, "1")) == 16
        assert sum(int(n.findtext("duration")) for n in staff_notes(m, "2")) == 16
    first = staff_notes(ms[0], "1")
    assert first[0].findtext("type") == "eighth"
    assert first[0].find("pitch/step").text == "C" and first[0].find("pitch/octave").text == "4"
    assert first[0].find("beam").get("number") == "1" and first[0].find("beam").text == "begin"
    assert first[1].find("beam").text == "end"
    last = staff_notes(ms[-1], "1")[-1]
    assert last.findtext("type") == "half"
    assert last.find("pitch/step").text == "C" and last.find("pitch/octave").text == "4"
    s2 = staff_notes(ms[0], "2")[0]
    assert s2.find("pitch/step").text == "C" and s2.find("pitch/octave").text == "3"
    assert ms[-1].find("barline/bar-style").text == "light-heavy"


def test_xml_c_major_4oct_rh_beams():
    first = staff_notes(parse(BY_KEY["c-major-4oct-rh"]).find("part/measure"), "1")[0]
    assert [(b.get("number"), b.text) for b in first.findall("beam")] == [("1", "begin"), ("2", "begin")]


def test_xml_c_major_1oct_lh():
    root = parse(BY_KEY["c-major-1oct-lh"])
    ms = root.findall("part/measure")
    assert len(ms) == 4
    for m in ms:
        notes = staff_notes(m, "1")
        assert len(notes) == 1 and notes[0].find("rest") is not None
    s2 = staff_notes(ms[0], "2")[0]
    assert s2.find("pitch/step").text == "C" and s2.find("pitch/octave").text == "3"
    assert s2.findtext("type") == "quarter"
    assert s2.find("beam") is None


@pytest.mark.parametrize("key,fifths,mode", [
    ("c-major-1oct-rh", "0", "major"),
    ("db-major-1oct-rh", "-5", "major"),
    ("fs-major-1oct-rh", "6", "major"),
    ("d-minor-natural-1oct-rh", "-1", "minor"),
    ("eb-minor-harmonic-1oct-rh", "-6", "minor"),
    ("gs-minor-melodic-1oct-rh", "5", "minor"),
    ("c-arp-dom7-1oct-rh", "-1", "major"),
    ("db-arp-dom7-1oct-rh", "-6", "major"),
    ("b-arp-dim7-1oct-rh", "0", None),
    ("c-chromatic-1oct-rh", "0", None),
])
def test_key_signatures(key, fifths, mode):
    k = parse(BY_KEY[key]).find("part/measure/attributes/key")
    assert k.findtext("fifths") == fifths
    assert k.findtext("mode") == mode


def test_key_names():
    assert S.key_name("arp-dom7", 0) == "F major"
    assert S.key_name("arp-dom7", 1) == "Gb major"
    assert S.key_name("minor-natural", 2) == "D minor"
    assert S.key_name("chromatic", 0) is None


def test_generate_subset(tmp_path):
    lib = Library(tmp_path / "lib")
    ids = generate(lib, keys={"d-minor-natural-2oct-rh", "c-major-1oct-ht"})
    assert ids == ["scales:c-major-1oct-ht", "scales:d-minor-natural-2oct-rh"]
    row = lib.get("scales:d-minor-natural-2oct-rh")
    assert row["source"] == "scales"
    assert row["key"] == "D minor"
    assert row["time_signature"] == "4/4"
    assert row["seconds"] == 12.0
    assert row["n_notes"] == 29
    assert row["piano_only"] == 1
    assert 1 <= row["difficulty"] <= 5
    assert "2oct" in row["tags"]
    assert (lib.data_dir / row["file_path"]).read_text(encoding="utf-8") == \
        musicxml(BY_KEY["d-minor-natural-2oct-rh"])
    assert lib.get("scales:c-major-1oct-ht")["n_notes"] == 30
    lib.close()


def test_sync_all(made):
    d, lib, before, msg, elapsed = made
    assert msg == "Made 972 scales and arpeggios"
    count = lib.conn.execute(
        "SELECT COUNT(*) FROM scores WHERE source='scales' AND file_path IS NOT NULL").fetchone()[0]
    assert count == 972
    assert len(list((d / "files" / "scales").glob("*.musicxml"))) == 972
    assert len(list((d / "files" / "scales").glob("*.musicxml.fingering.json"))) == 972
    assert elapsed < 90


def test_setup_done_flag(made):
    d, lib, before, msg, elapsed = made
    assert before is False
    assert ScalesSource().setup_steps(lib)[0].done is True


def test_search_d_minor_2oct(made):
    d, lib, _, _, _ = made
    rows = lib.search("scale d minor 2oct", source="scales", downloaded=True, limit=None)
    assert {r["id"] for r in rows} == {f"scales:d-minor-{k}-2oct-{h}"
                                       for k in ("natural", "harmonic", "melodic") for h in ("rh", "lh", "ht")}


def test_search_arpeggio(made):
    d, lib, _, _, _ = made
    rows = lib.search("arpeggio c major 1oct", source="scales", downloaded=True, limit=None)
    assert {r["id"] for r in rows} == {f"scales:c-arp-major-1oct-{h}" for h in ("rh", "lh", "ht")}


def test_search_plural_words(made):
    d, lib, _, _, _ = made
    rows = lib.search("scales c major 1oct", source="scales", downloaded=True, limit=None)
    assert {r["id"] for r in rows} == {f"scales:c-major-1oct-{h}" for h in ("rh", "lh", "ht")}
    rows = lib.search("arpeggios c major 1oct", source="scales", downloaded=True, limit=None)
    assert {r["id"] for r in rows} == {f"scales:c-arp-major-1oct-{h}" for h in ("rh", "lh", "ht")}


def test_api(made):
    d, lib, _, _, _ = made
    r = handle_request(d, "/api/scores?q=scale%20d%20minor%202oct")
    assert r.status == 200
    data = json.loads(r.body)
    ids = {s["id"] for s in data["scores"] if s["source"] == "scales"}
    assert ids == {f"scales:d-minor-{k}-2oct-{h}" for k in ("natural", "harmonic", "melodic") for h in ("rh", "lh", "ht")}
    src = next(s for s in data["sources"] if s["name"] == "scales")
    assert src["label"] == "Scales and arpeggios"
    assert src["steps"][0]["done"] is True


def test_music21_reads_a_scale(made):
    d, lib, _, _, _ = made
    row = lib.get("scales:c-major-2oct-ht")
    sc = compare.load_score(d / row["file_path"])
    assert len(compare.expected_notes(sc, hands="right")[0]) == 29
    assert len(compare.expected_notes(sc, hands="left")[0]) == 29


def test_registered(tmp_path):
    lib = Library(tmp_path / "lib")
    assert list(all_sources()) == ["local", "pdmx", "gen", "scales"]
    assert isinstance(get_source("scales"), ScalesSource)
    with pytest.raises(UnsupportedCommand):
        ScalesSource().sync(lib, tmp_path / "x.csv")
    with pytest.raises(LookupError):
        ScalesSource().run_setup_step(lib, "nope")
    assert ScalesSource().search(lib, "scale") == []
    lib.close()
