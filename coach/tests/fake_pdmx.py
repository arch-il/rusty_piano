import argparse
import csv
import io
import tarfile
import tempfile
import zipfile
from pathlib import Path

from rusty_piano_coach.library import pdmx
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

FAKE_IDS = {
    "hymn": "pdmx:QmFakeAAAA",
    "duet": "pdmx:QmFakeDDDD",
    "conflict": "pdmx:QmFakeBBBB",
    "missing": "pdmx:QmFakeEEEE",
}

CONTAINER_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    "<container><rootfiles>"
    '<rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>'
    "</rootfiles></container>"
)

ROWS = [
    {
        "mxl": "./mxl/1/11/QmFakeAAAA.mxl", "title": "Hymn Test", "composer_name": "Test Composer",
        "complexity": "1", "tracks": "0", "n_tracks": "1", "song_length.seconds": "41.4",
        "n_notes": "360", "rating": "4.5", "license": "publicdomain", "subset:no_license_conflict": "True",
    },
    {
        "mxl": "./mxl/3/33/QmFakeDDDD.mxl", "title": "Duet Test", "composer_name": "Fake Duo",
        "complexity": "2", "tracks": "0-0", "n_tracks": "2", "song_length.seconds": "60",
        "n_notes": "500", "license": "publicdomain", "subset:no_license_conflict": "True",
    },
    {"mxl": "./mxl/2/22/QmFakeBBBB.mxl", "title": "Conflict Test", "subset:no_license_conflict": "False"},
    {
        "mxl": "./mxl/4/44/QmFakeEEEE.mxl", "title": "Missing Test", "composer_name": "Nobody",
        "subset:no_license_conflict": "True",
    },
]

FIXTURES = Path(__file__).parent / "fixtures"


def write_csv(path) -> Path:
    path = Path(path)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        for r in ROWS:
            row = {c: "NA" for c in COLUMNS}
            row.update(r)
            w.writerow(row)
    return path


def _mxl_bytes(src: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("META-INF/container.xml", CONTAINER_XML)
        zf.writestr("score.musicxml", src.read_bytes())
    return buf.getvalue()


def write_archive(path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    members = {
        "mxl/1/11/QmFakeAAAA.mxl": FIXTURES / "simple_c_major.musicxml",
        "mxl/3/33/QmFakeDDDD.mxl": FIXTURES / "two_hands_e_minor.musicxml",
    }
    with tarfile.open(path, "w:gz") as tar:
        for name, src in members.items():
            data = _mxl_bytes(src)
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return path


def build(data_dir, *, catalogue=True, archive=True) -> Path:
    data_dir = Path(data_dir)
    if catalogue:
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = write_csv(Path(tmp) / "PDMX.csv")
            lib = Library(data_dir)
            try:
                lib.upsert_catalogue(pdmx.read_catalogue(csv_path))
            finally:
                lib.close()
    if archive:
        write_archive(data_dir / "sources" / "pdmx" / "mxl.tar.gz")
    return data_dir


def fake_open_url(data: bytes):
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

    return lambda url, headers=None: Resp()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("data_dir")
    ap.add_argument("--no-catalogue", action="store_true")
    ap.add_argument("--no-archive", action="store_true")
    a = ap.parse_args()
    d = build(a.data_dir, catalogue=not a.no_catalogue, archive=not a.no_archive)
    print(f"Fake PDMX ready in {d.resolve()}: catalogue {'no' if a.no_catalogue else 'yes'}, archive {'no' if a.no_archive else 'yes'}")
