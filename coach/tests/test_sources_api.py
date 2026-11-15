import hashlib

import pytest
from fake_pdmx import FAKE_IDS, build, fake_open_url, write_archive, write_csv

from rusty_piano_coach.cli import main
from rusty_piano_coach.library import fetch, pdmx
from rusty_piano_coach.library.index import Library
from rusty_piano_coach.library.local import LocalSource
from rusty_piano_coach.library.pdmx import PdmxSource
from rusty_piano_coach.library.sources import Source, UnsupportedCommand


def ids(rows):
    return [r["id"] for r in rows]


def recorder():
    calls = []

    def rec(*args):
        calls.append(args)

    rec.calls = calls
    return rec


def test_base_source(tmp_path):
    s = Source()
    with Library(tmp_path / "lib") as lib:
        assert s.setup_steps(lib) == []
        with pytest.raises(UnsupportedCommand):
            s.run_setup_step(lib, "x")
        assert s.label == ""
        assert s.search(lib, "x") == []


def test_labels():
    assert PdmxSource().label == "PDMX"
    assert LocalSource().label == "Your files"


def test_setup_steps_fresh(tmp_path):
    d = tmp_path / "lib"
    with Library(d) as lib:
        steps = PdmxSource().setup_steps(lib)
    assert [s.id for s in steps] == ["catalogue", "archive"]
    assert [s.needed_for for s in steps] == ["search", "download"]
    assert [s.done for s in steps] == [False, False]
    assert not (d / "sources").exists()


def test_catalogue_step(tmp_path, capsys, monkeypatch):
    csv_path = write_csv(tmp_path / "PDMX.csv")
    data = csv_path.read_bytes()
    monkeypatch.setattr(fetch, "open_url", fake_open_url(data))
    monkeypatch.setattr(pdmx, "CSV_MD5", hashlib.md5(data).hexdigest())
    rec = recorder()
    with Library(tmp_path / "lib") as lib:
        src = PdmxSource()
        assert src.run_setup_step(lib, "catalogue", rec) == "Loaded 4 PDMX scores"
        assert src.setup_steps(lib)[0].done is True
    cap = capsys.readouterr()
    assert cap.out == "" and cap.err == ""
    phases = {c[0]: c[3] for c in rec.calls}
    assert phases["Downloading the catalogue"] == "bytes"
    assert phases["Loading catalogue rows"] == "items"
    assert all(len(c) == 4 for c in rec.calls)


def test_archive_step(tmp_path, capsys, monkeypatch):
    arc = write_archive(tmp_path / "src" / "mxl.tar.gz")
    data = arc.read_bytes()
    monkeypatch.setattr(fetch, "open_url", fake_open_url(data))
    monkeypatch.setattr(pdmx, "ARCHIVE_MD5", hashlib.md5(data).hexdigest())
    rec = recorder()
    d = tmp_path / "lib"
    with Library(d) as lib:
        src = PdmxSource()
        assert src.run_setup_step(lib, "archive", rec) == "PDMX score archive ready"
        assert src.setup_steps(lib)[1].done is True
    cap = capsys.readouterr()
    assert cap.out == "" and cap.err == ""
    assert (d / "sources" / "pdmx" / "mxl.tar.gz").exists()
    assert rec.calls and all(len(c) == 4 for c in rec.calls)
    assert {c[0] for c in rec.calls} == {"Downloading the score archive"}


def test_unknown_step(tmp_path):
    with Library(tmp_path / "lib") as lib:
        with pytest.raises(LookupError):
            PdmxSource().run_setup_step(lib, "nope")


def test_search(tmp_path, fixtures_dir):
    d = build(tmp_path / "lib", archive=False)
    with Library(d) as lib:
        s = PdmxSource()
        assert ids(s.search(lib, "hymn")) == [FAKE_IDS["hymn"]]
        assert s.search(lib, "conflict") == []
        assert s.search(lib, "   ") == []
        assert s.search(lib, "!!") == []
        assert set(ids(s.search(lib, "test"))) == {FAKE_IDS["hymn"], FAKE_IDS["duet"], FAKE_IDS["missing"]}
        assert len(s.search(lib, "test", limit=2)) == 2
        hymn = lib.get(FAKE_IDS["hymn"])["difficulty"]
        duet = lib.get(FAKE_IDS["duet"])["difficulty"]
        got = ids(s.search(lib, "test", difficulty=(hymn, hymn)))
        assert FAKE_IDS["hymn"] in got
        if duet != hymn:
            assert FAKE_IDS["duet"] not in got
        assert FAKE_IDS["missing"] not in got
        assert FAKE_IDS["hymn"] in ids(s.search(lib, "hymn", key="C major"))
    assert main(["scores", "--data-dir", str(d), "import", str(fixtures_dir)]) == 0
    with Library(d) as lib:
        assert LocalSource().search(lib, "test") == []


def test_undownloaded_filter(tmp_path):
    d = build(tmp_path / "lib")
    with Library(d) as lib:
        assert len(lib.search("test", source="pdmx", undownloaded=True)) == 3
        PdmxSource().download(lib, [FAKE_IDS["hymn"]])
        assert FAKE_IDS["hymn"] not in ids(lib.search("test", source="pdmx", undownloaded=True))
        assert FAKE_IDS["hymn"] in ids(lib.search("test", source="pdmx"))


def test_download_with_progress(tmp_path):
    d = build(tmp_path / "lib")
    rec = recorder()
    with Library(d) as lib:
        assert PdmxSource().download(lib, [FAKE_IDS["hymn"]], progress=rec) == [FAKE_IDS["hymn"]]
        assert lib.get(FAKE_IDS["hymn"])["file_path"]
    assert any(c[0] == "Scanning the PDMX archive" for c in rec.calls)


def test_ensure_file_progress_quiet(tmp_path, capsys):
    src = tmp_path / "a.bin"
    src.write_bytes(b"x" * 100)
    rec = recorder()
    fetch.ensure_file(tmp_path / "out" / "b.bin", hashlib.md5(b"x" * 100).hexdigest(),
                      url="http://unused", from_file=src, progress=rec)
    cap = capsys.readouterr()
    assert cap.out == "" and cap.err == ""
    assert rec.calls
