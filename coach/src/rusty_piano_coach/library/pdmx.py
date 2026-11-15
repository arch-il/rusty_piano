import csv
import sys
import tarfile
import time
from pathlib import Path

from . import fetch
from .analyse import AnalysisError, analyse_file
from .difficulty import catalogue_difficulty, score_difficulty
from .paths import files_dir, source_dir
from .sources import SetupStep, Source

RECORD_URL = "https://zenodo.org/records/15571083"
CSV_NAME = "PDMX.csv"
CSV_URL = "https://zenodo.org/records/15571083/files/PDMX.csv?download=1"
CSV_MD5 = "30392ccf38bb63ce70e7afae70f9c88c"
ARCHIVE_NAME = "mxl.tar.gz"
ARCHIVE_URL = "https://zenodo.org/records/15571083/files/mxl.tar.gz?download=1"
ARCHIVE_MD5 = "49ffd75ecf5489c0be6d41182eb11ff7"
PIANO_PROGRAMS = {0, 1, 2, 3}
DATASET_CREDIT = "via PDMX (Long et al., 2024), CC BY 4.0, https://zenodo.org/records/15571083"


def na(v):
    if v is None:
        return None
    v = v.strip()
    if v in ("", "NA", "N/A"):
        return None
    return v


def to_int(v):
    v = na(v)
    if v is None:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def to_float(v):
    v = na(v)
    if v is None:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def member_basename(name: str) -> str:
    return name.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]


def row_to_record(row: dict):
    mxl = na(row["mxl"])
    if mxl is None:
        return None
    name = member_basename(mxl)
    hash_ = name[:-4] if name.endswith(".mxl") else name
    source_ref = mxl[2:] if mxl.startswith("./") else mxl
    complexity = to_int(row["complexity"])
    source_complexity = complexity if complexity in (1, 2, 3) else None
    seconds = to_float(row["song_length.seconds"])
    n_notes = to_int(row["n_notes"])
    tracks = na(row["tracks"])
    if tracks is None:
        piano_only = None
    else:
        try:
            piano_only = int(all(int(t) in PIANO_PROGRAMS for t in tracks.split("-")))
        except ValueError:
            piano_only = None
    rating = to_float(row["rating"])
    if rating == 0.0:
        rating = None
    composer = na(row["composer_name"])
    artist = na(row["artist_name"])
    difficulty = catalogue_difficulty(source_complexity, n_notes, seconds)
    return {
        "id": f"pdmx:{hash_}",
        "source": "pdmx",
        "title": na(row["title"]) or na(row["song_name"]) or "(untitled)",
        "composer": composer,
        "artist": artist,
        "tags": na(row["tags"]),
        "genres": na(row["genres"]),
        "seconds": seconds,
        "n_notes": n_notes,
        "notes_per_bar": to_float(row["notes_per_bar"]),
        "n_tracks": to_int(row["n_tracks"]),
        "piano_only": piano_only,
        "source_complexity": source_complexity,
        "rating": rating,
        "n_ratings": to_int(row["n_ratings"]),
        "n_views": to_int(row["n_views"]),
        "license": na(row["license"]),
        "license_url": na(row["license_url"]),
        "license_conflict": 1 if row.get("subset:no_license_conflict") == "False" else 0,
        "attribution": f"{composer or artist or 'unknown composer'} - {DATASET_CREDIT}",
        "source_ref": source_ref,
        "difficulty": difficulty,
        "difficulty_basis": "catalogue" if difficulty is not None else None,
    }


def read_catalogue(csv_path):
    csv.field_size_limit(2**31 - 1)
    with open(csv_path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            rec = row_to_record(row)
            if rec is not None:
                yield rec


def extract_members(archive: Path, wanted: set, progress=None) -> dict:
    remaining = set(wanted)
    found = {}
    total_size = Path(archive).stat().st_size
    with open(archive, "rb") as f, tarfile.open(fileobj=f, mode="r|gz") as tar:
        count = 0
        for member in tar:
            count += 1
            if progress and count % 2000 == 0:
                progress(f.tell(), total_size)
            if member.isfile():
                base = member_basename(member.name)
                if base in remaining:
                    found[base] = tar.extractfile(member).read()
                    remaining.discard(base)
                    if not remaining:
                        break
    return found


def _loaded(k):
    sys.stderr.write(f"\r  loaded {k:,} rows")
    sys.stderr.flush()


class PdmxSource(Source):
    name = "pdmx"
    label = "PDMX"
    keeps_catalogue_row = True
    description = "PDMX: about 254k public-domain MusicXML scores from MuseScore (Zenodo record 15571083)"

    def sync(self, lib, from_file, progress=None):
        if progress is not None:
            csv_path = fetch.ensure_file(
                source_dir(lib.data_dir, "pdmx") / CSV_NAME, CSV_MD5,
                url=CSV_URL, from_file=from_file, label="PDMX catalogue",
                progress=lambda d, t: progress("Downloading the catalogue", d, t, "bytes"),
            )
            return lib.upsert_catalogue(
                read_catalogue(csv_path),
                progress=lambda k: progress("Loading catalogue rows", k, None, "items"),
            )
        csv_path = fetch.ensure_file(
            source_dir(lib.data_dir, "pdmx") / CSV_NAME, CSV_MD5,
            url=CSV_URL, from_file=from_file, label="PDMX catalogue",
        )
        t0 = time.monotonic()
        n = lib.upsert_catalogue(read_catalogue(csv_path), progress=_loaded)
        sys.stderr.write("\n")
        print(f"Loaded {n:,} PDMX scores in {time.monotonic() - t0:.1f} s")
        return n

    def fetch_archive(self, lib, from_file, progress=None):
        kw = {}
        if progress is not None:
            kw["progress"] = lambda d, t: progress("Downloading the score archive", d, t, "bytes")
        return fetch.ensure_file(
            source_dir(lib.data_dir, "pdmx") / ARCHIVE_NAME, ARCHIVE_MD5,
            url=ARCHIVE_URL, from_file=from_file, label="PDMX archive", **kw,
        )

    def setup_steps(self, lib):
        loaded = lib.conn.execute("SELECT 1 FROM scores WHERE source='pdmx' LIMIT 1").fetchone() is not None
        present = (Path(lib.data_dir) / "sources" / "pdmx" / ARCHIVE_NAME).is_file()
        return [
            SetupStep("catalogue", "Catalogue", "PDMX.csv, about 225 MB. Lets you search the 254k PDMX scores.", "search", loaded),
            SetupStep("archive", "Score archive", "mxl.tar.gz, about 1.9 GB. Lets you download PDMX scores.", "download", present),
        ]

    def run_setup_step(self, lib, step_id, progress=None):
        if step_id == "catalogue":
            n = self.sync(lib, None, progress=progress)
            return f"Loaded {n:,} PDMX scores"
        if step_id == "archive":
            self.fetch_archive(lib, None, progress=progress)
            return "PDMX score archive ready"
        raise LookupError(f"source 'pdmx' has no setup step '{step_id}'")

    def download(self, lib, ids, progress=None):
        archive = source_dir(lib.data_dir, "pdmx") / ARCHIVE_NAME
        if not archive.exists():
            raise FileNotFoundError("PDMX archive not found; run: coach scores fetch-archive pdmx")

        def quiet(*args):
            pass

        say = print if progress is None else quiet
        wanted = {}
        for i in ids:
            row = lib.get(i)
            if row["file_path"] and (lib.data_dir / row["file_path"]).exists():
                say(f"already downloaded: #{row['num']} {row['title']}")
            else:
                wanted[member_basename(row["source_ref"])] = row
        if not wanted:
            return []
        say(f"Scanning the PDMX archive for {len(wanted)} score(s); this reads up to 1.9 GB and can take about 30 s...")
        if progress is None:
            printer = fetch.ProgressPrinter("scanning")
            found = extract_members(archive, set(wanted), progress=printer)
            printer.finish()
        else:
            found = extract_members(
                archive, set(wanted),
                progress=lambda d, t: progress("Scanning the PDMX archive", d, t, "bytes"),
            )
            size = archive.stat().st_size
            progress("Scanning the PDMX archive", size, size, "bytes")
        for base, row in wanted.items():
            if base not in found:
                say(f"not found in archive: {row['id']}")
        done = []
        for base, data in found.items():
            row = wanted[base]
            dest = files_dir(lib.data_dir, "pdmx") / base
            dest.write_bytes(data)
            rel = dest.relative_to(lib.data_dir).as_posix()
            try:
                a = analyse_file(dest)
            except AnalysisError as e:
                dest.unlink(missing_ok=True)
                say(f"warning: could not read {row['id']} ({e}); not added")
                continue
            lib.update_analysis(
                row["id"], file_path=rel, key=a.key, time_signature=a.time_signature,
                seconds=a.seconds, n_notes=a.n_notes, piano_only=a.piano_only,
                difficulty=score_difficulty(a, row["source_complexity"]),
            )
            r = lib.get(row["id"])
            say(f"downloaded #{r['num']} {r['title']} ({r['key'] or '?'}, {r['time_signature'] or '?'}, difficulty {r['difficulty'] or '?'})")
            done.append(row["id"])
        return done
