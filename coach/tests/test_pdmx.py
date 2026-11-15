import csv
import hashlib
import io
import tarfile

import pytest

from rusty_piano_coach.cli import main
from rusty_piano_coach.library import fetch, pdmx
from rusty_piano_coach.library.difficulty import catalogue_difficulty
from rusty_piano_coach.library.index import Library

COLUMNS = (
    "path, metadata, mxl, pdf, mid, version, is_user_pro, is_user_publisher, is_user_staff, has_paywall, "
    "is_rated, is_official, is_original, is_draft, has_custom_audio, has_custom_video, n_comments, "
    "n_favorites, n_views, n_ratings, rating, license, license_url, license_conflict, genres, groups, "
    "tags, song_name, title, subtitle, artist_name, composer_name, publisher, complexity, n_tracks, "
    "tracks, song_length, song_length.seconds, song_length.bars, song_length.beats, n_notes, "
    "notes_per_bar, n_annotations, has_annotations, n_lyrics, has_lyrics, n_tokens, pitch_class_entropy, "
    "scale_consistency, groove_consistency, best_path, is_best_path, best_arrangement, "
    "is_best_arrangement, best_unique_arrangement, is_best_unique_arrangement, subset:all, "
    "subset:rated, subset:deduplicated, subset:rated_deduplicated, subset:no_license_conflict, "
    "subset:all_valid"
).split(", ")

ROWS = {
    "A": {
        "mxl": "./mxl/1/11/QmTestAAAA.mxl", "title": "Hymn Test", "composer_name": "Test Composer",
        "complexity": "1", "tracks": "0-0", "n_tracks": "2", "song_length.seconds": "41.4",
        "n_notes": "360", "rating": "4.66", "license": "publicdomain", "subset:no_license_conflict": "True",
    },
    "B": {"mxl": "./mxl/2/22/QmTestBBBB.mxl", "title": "Conflict Piece", "subset:no_license_conflict": "False"},
    "C": {"mxl": "NA"},
    "D": {
        "mxl": "./mxl/3/33/QmTestDDDD.mxl", "title": "Duet Test", "tracks": "0-40", "complexity": "0",
        "rating": "0", "subset:no_license_conflict": "True",
    },
    "E": {"mxl": "./mxl/4/44/QmTestEEEE.mxl", "title": "Missing Member", "subset:no_license_conflict": "True"},
}


def full_row(over):
    row = {c: "NA" for c in COLUMNS}
    row.update(over)
    return row


def write_csv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow(full_row(r))


def md5(path):
    return hashlib.md5(path.read_bytes()).hexdigest()


def add_bytes(tar, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    tar.addfile(info, io.BytesIO(data))


def test_row_to_record():
    a = pdmx.row_to_record(full_row(ROWS["A"]))
    assert a["id"] == "pdmx:QmTestAAAA"
    assert a["source_ref"] == "mxl/1/11/QmTestAAAA.mxl"
    assert a["piano_only"] == 1
    assert a["license_conflict"] == 0
    assert a["source_complexity"] == 1
    assert a["difficulty"] == catalogue_difficulty(1, 360, 41.4)
    assert a["attribution"].startswith("Test Composer - via PDMX")
    assert pdmx.row_to_record(full_row(ROWS["B"]))["license_conflict"] == 1
    assert pdmx.row_to_record(full_row(ROWS["C"])) is None
    d = pdmx.row_to_record(full_row(ROWS["D"]))
    assert d["piano_only"] == 0 and d["source_complexity"] is None and d["rating"] is None


def test_member_basename():
    assert pdmx.member_basename("./mxl/1/11/x.mxl") == pdmx.member_basename("mxl\\1\\11\\x.mxl") == "x.mxl"


def test_extract_members_dot_prefix(tmp_path):
    arc = tmp_path / "a.tar.gz"
    with tarfile.open(arc, "w:gz") as tar:
        add_bytes(tar, "./mxl/1/11/QmTestAAAA.mxl", b"hello")
        add_bytes(tar, "mxl/9/99/QmOther.mxl", b"other")
    assert pdmx.extract_members(arc, {"QmTestAAAA.mxl"}) == {"QmTestAAAA.mxl": b"hello"}


@pytest.fixture
def env(tmp_path, fixtures_dir, make_mxl, monkeypatch):
    csv_path = tmp_path / "in.csv"
    write_csv(csv_path, ROWS.values())
    a = make_mxl(fixtures_dir / "simple_c_major.musicxml", tmp_path / "a.mxl")
    d = make_mxl(fixtures_dir / "two_hands_e_minor.musicxml", tmp_path / "d.mxl")
    arc = tmp_path / "in.tar.gz"
    with tarfile.open(arc, "w:gz") as tar:
        dirinfo = tarfile.TarInfo("mxl")
        dirinfo.type = tarfile.DIRTYPE
        tar.addfile(dirinfo)
        add_bytes(tar, "mxl/1/11/QmTestAAAA.mxl", a.read_bytes())
        add_bytes(tar, "mxl/3/33/QmTestDDDD.mxl", d.read_bytes())
        add_bytes(tar, "mxl/9/99/QmOther.mxl", b"decoy")
    monkeypatch.setattr(pdmx, "CSV_MD5", md5(csv_path))
    monkeypatch.setattr(pdmx, "ARCHIVE_MD5", md5(arc))
    return tmp_path / "lib", csv_path, arc


def run(capsys, d, *args):
    code = main(["scores", "--data-dir", str(d), *args])
    cap = capsys.readouterr()
    return code, cap


def test_flow(env, capsys):
    d, csv_path, arc = env
    code, cap = run(capsys, d, "sync", "pdmx", "--from", str(csv_path))
    assert code == 0
    assert "Loaded 4 PDMX scores" in cap.out
    assert (d / "sources" / "pdmx" / "PDMX.csv").exists()

    assert "Hymn Test" in run(capsys, d, "search", "hymn")[1].out
    assert "No scores found." in run(capsys, d, "search", "conflict")[1].out
    assert "Conflict Piece" in run(capsys, d, "search", "conflict", "--include-conflicts")[1].out

    code, cap = run(capsys, d, "download", "pdmx:QmTestAAAA")
    assert code == 1
    assert "fetch-archive pdmx" in cap.err

    assert run(capsys, d, "fetch-archive", "pdmx", "--from", str(arc))[0] == 0

    num_d = Library(d).get("pdmx:QmTestDDDD")["num"]
    code, cap = run(capsys, d, "download", "pdmx:QmTestAAAA", str(num_d), "pdmx:QmTestEEEE")
    assert code == 1
    assert "not downloaded" in cap.err
    assert cap.out.count("downloaded #") == 2
    assert "not found in archive: pdmx:QmTestEEEE" in cap.out
    assert (d / "files" / "pdmx" / "QmTestAAAA.mxl").exists()

    out = run(capsys, d, "show", "pdmx:QmTestAAAA")[1].out
    assert "Key: C major" in out and "Time signature: 4/4" in out and "(from score)" in out
    assert "Duet Test" in run(capsys, d, "search", "--downloaded", "--key", "E minor")[1].out
    assert Library(d).get("pdmx:QmTestDDDD")["piano_only"] == 0

    assert "already downloaded" in run(capsys, d, "download", "pdmx:QmTestAAAA")[1].out

    assert run(capsys, d, "sync", "pdmx", "--from", str(csv_path))[0] == 0
    assert "Key: C major" in run(capsys, d, "show", "pdmx:QmTestAAAA")[1].out


def test_sync_network(env, capsys, monkeypatch):
    d, csv_path, _ = env
    data = csv_path.read_bytes()

    class Resp:
        status = 200
        headers = {"Content-Length": str(len(data))}

        def __init__(self):
            self.buf = io.BytesIO(data)

        def read(self, n=-1):
            return self.buf.read(n)

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(fetch, "open_url", lambda url, headers=None: Resp())
    code, cap = run(capsys, d, "sync", "pdmx")
    assert code == 0
    assert "Loaded 4 PDMX scores" in cap.out


def test_sources_lists_both(tmp_path, capsys):
    out = run(capsys, tmp_path / "lib", "sources")[1].out
    assert "local" in out and "pdmx" in out


def test_unreadable_member_not_added(env, capsys, tmp_path):
    d, csv_path, _ = env
    arc = tmp_path / "junk.tar.gz"
    with tarfile.open(arc, "w:gz") as tar:
        add_bytes(tar, "mxl/1/11/QmTestAAAA.mxl", b"junk not a zip")
    assert run(capsys, d, "sync", "pdmx", "--from", str(csv_path))[0] == 0
    dest = d / "sources" / "pdmx"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "mxl.tar.gz").write_bytes(arc.read_bytes())
    code, cap = run(capsys, d, "download", "pdmx:QmTestAAAA")
    assert code == 1
    assert "warning: could not read pdmx:QmTestAAAA" in cap.out
    assert "not added" in cap.out
    assert "downloaded #" not in cap.out
    assert Library(d).get("pdmx:QmTestAAAA")["file_path"] is None
    assert not (d / "files" / "pdmx" / "QmTestAAAA.mxl").exists()
    assert "not downloaded" in run(capsys, d, "show", "pdmx:QmTestAAAA")[1].out


def test_corrupt_archive_clean_error(env, capsys):
    d, csv_path, _ = env
    assert run(capsys, d, "sync", "pdmx", "--from", str(csv_path))[0] == 0
    dest = d / "sources" / "pdmx"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "mxl.tar.gz").write_bytes(b"this is not gzip at all")
    code, cap = run(capsys, d, "download", "pdmx:QmTestAAAA")
    assert code == 1
    assert "error:" in cap.err and "fetch-archive" in cap.err
    assert "Traceback" not in cap.err
