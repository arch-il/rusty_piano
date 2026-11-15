import json
from pathlib import Path

from rusty_piano_coach.library.index import Library
from rusty_piano_coach.server import handle_request


def add(d: Path, score_id: str, source: str, title: str) -> None:
    lib = Library(d)
    file = d / "files" / source / (score_id.split(":", 1)[1] + ".musicxml")
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("<score-partwise/>", encoding="utf-8")
    lib.upsert_catalogue([{"id": score_id, "source": source, "title": title, "composer": "x", "license_conflict": 0}])
    lib.update_analysis(score_id, file_path=file.relative_to(d).as_posix(), key="C major", time_signature="4/4")
    lib.close()


def get(d: Path, path: str) -> dict:
    return json.loads(handle_request(d, path).body)


def test_empty_query_hides_scales(tmp_path):
    d = tmp_path / "lib"
    add(d, "local:zebra", "local", "Zebra waltz")
    add(d, "scales:c-major-1oct-rh", "scales", "C major scale, 1 octave, right hand")
    add(d, "gen:t1-quarters-rh", "gen", "T1 Quarter notes (right hand)")
    answer = get(d, "/api/scores")
    assert [s["id"] for s in answer["scores"]] == ["gen:t1-quarters-rh", "local:zebra"]
    assert answer["total"] == 2
    assert get(d, "/api/scores?q=scale")["total"] >= 1


def test_query_shows_scales(tmp_path):
    d = tmp_path / "lib"
    add(d, "local:zebra", "local", "Zebra waltz")
    add(d, "scales:c-major-1oct-rh", "scales", "C major scale, 1 octave, right hand")
    add(d, "gen:t1-quarters-rh", "gen", "T1 Quarter notes (right hand)")
    ids = [s["id"] for s in get(d, "/api/scores?q=scale")["scores"]]
    assert "scales:c-major-1oct-rh" in ids


def test_limit_counts_only_shown_rows(tmp_path):
    d = tmp_path / "lib"
    add(d, "scales:a-major-1oct-rh", "scales", "A major scale, 1 octave, right hand")
    add(d, "scales:b-major-1oct-rh", "scales", "B major scale, 1 octave, right hand")
    add(d, "local:zebra", "local", "Zebra waltz")
    add(d, "local:zulu", "local", "Zulu dance")
    assert [s["id"] for s in get(d, "/api/scores?limit=2")["scores"]] == ["local:zebra", "local:zulu"]
