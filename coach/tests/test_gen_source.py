import json
import re
import xml.etree.ElementTree as ET

import pytest

from rusty_piano_coach import compare, plan
from rusty_piano_coach.cli import main
from rusty_piano_coach.library import gen
from rusty_piano_coach.library.gen import CATALOGUE, GenSource, musicxml
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.sources import UnsupportedCommand
from rusty_piano_coach.server import handle_request

BY_KEY = {e.key: e for e in CATALOGUE}


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    d = tmp_path_factory.mktemp("gen") / "lib"
    lib = Library(d)
    src = GenSource()
    before = src.setup_steps(lib)[0].done
    msg = src.run_setup_step(lib, "exercises")
    yield d, lib, before, msg
    lib.close()


def get_json(d, path):
    r = handle_request(d, path)
    return r.status, json.loads(r.body)


def test_catalogue_unique():
    assert len(CATALOGUE) == 30
    assert len({e.key for e in CATALOGUE}) == 30


def test_bars_total_16():
    for ex in CATALOGUE:
        for bar in gen._bars(ex):
            assert sum(gen.DIVISIONS[n[4]] for n in bar) == 16


def test_bad_bar_raises():
    bad = gen.Exercise("x", "x", "R1", "reading", 1, 60, "C4 C4 C4")
    with pytest.raises(ValueError):
        musicxml(bad)


def test_deterministic():
    for ex in CATALOGUE:
        assert musicxml(ex) == musicxml(ex)


def test_reading_snippets():
    music = [BY_KEY[f"r2-read-{n}"].music for n in range(1, 7)]
    assert len(set(music)) == 6
    for m in music:
        for tok in m.replace("|", " ").split():
            assert tok.split(":")[0] in {"C4", "D4", "E4", "F4", "G4"}


def test_xml_structure():
    root = ET.fromstring(musicxml(BY_KEY["r2-steps"]).split("\n", 1)[1])
    assert root.find("work/work-title").text == "R2 Steps up and down (right hand)"
    assert root.find("part/measure/attributes/divisions").text == "4"
    assert root.find("part/measure/attributes/staves").text == "2"
    assert root.find("part/measure/direction/sound").get("tempo") == "60"
    measures = root.findall("part/measure")
    assert len(measures) == 3
    for m in measures:
        for n in m.findall("note"):
            tags = [c.tag for c in n]
            assert tags[0] in ("pitch", "rest")
            assert tags[1:] == ["duration", "voice", "type", "staff"]
        assert m.find("backup/duration").text == "16"
        rests = [n for n in m.findall("note") if n.find("rest") is not None]
        assert len(rests) == 1
        r = rests[0]
        assert r.find("rest").get("measure") == "yes"
        assert r.find("type").text == "whole"
        assert r.find("duration").text == "16"
        assert r.find("staff").text == "2"
    assert measures[-1].find("barline/bar-style").text == "light-heavy"


def test_tree_matches_catalogue():
    text = plan.SEED_TREE.read_text(encoding="utf-8")
    assert set(re.findall(r'"(gen:[^"]+)"', text)) == {"gen:" + e.key for e in gen.all_exercises()}


def test_generate(made):
    d, lib, before, msg = made
    everything = gen.all_exercises()
    assert msg == f"Made {len(everything)} exercises"
    rows = [lib.get("gen:" + e.key) for e in everything]
    for row in rows:
        assert row["source"] == "gen"
        assert row["file_path"]
        assert (d / row["file_path"]).exists()
        assert row["piano_only"] == 1
    for e in CATALOGUE:
        assert lib.get("gen:" + e.key)["time_signature"] == "4/4"
    assert len(list((d / "files" / "gen").iterdir())) == len(everything)


def test_setup_done_flag(made):
    d, lib, before, msg = made
    assert before is False
    assert GenSource().setup_steps(lib)[0].done is True


def load(made, key):
    d, lib, _, _ = made
    return compare.load_score(d / lib.get("gen:" + key)["file_path"])


def count(sc, hands):
    return len(compare.expected_notes(sc, hands=hands)[0])


def test_hands(made):
    sc = load(made, "r2-steps")
    assert count(sc, "right") == 9 and count(sc, "left") == 0
    sc = load(made, "r3-steps")
    assert count(sc, "left") == 9 and count(sc, "right") == 0
    assert count(load(made, "r1-all-cs"), "both") == 8


def test_cli_sync(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(gen, "all_exercises", lambda: list(CATALOGUE[:3]))
    d = tmp_path / "lib2"
    assert main(["scores", "--data-dir", str(d), "sync", "gen"]) == 0
    assert "Generated 3 exercises" in capsys.readouterr().out


def test_sync_from_unsupported(tmp_path):
    lib = Library(tmp_path / "lib3")
    with pytest.raises(UnsupportedCommand):
        GenSource().sync(lib, tmp_path / "x.csv")
    lib.close()


def test_api(made):
    d, lib, _, _ = made
    status, data = get_json(d, "/api/scores")
    assert status == 200
    assert [s["name"] for s in data["sources"]] == ["local", "pdmx", "gen", "scales"]
    gen_src = next(s for s in data["sources"] if s["name"] == "gen")
    assert gen_src["steps"][0]["done"] is True


def test_api_search_exercise(made):
    d, lib, _, _ = made
    status, data = get_json(d, "/api/scores?q=exercise")
    assert status == 200
    titles = {s["title"] for s in data["scores"] if s["source"] == "gen"}
    assert "R2 Steps up and down (right hand)" in titles
