import hashlib
import shutil
from pathlib import Path

from .analyse import AnalysisError, analyse_file
from .difficulty import score_difficulty
from .paths import files_dir
from .sources import Source

EXTENSIONS = {".musicxml", ".xml", ".mxl"}


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


class LocalSource(Source):
    name = "local"
    label = "Your files"
    description = "MusicXML files you add by hand (.musicxml, .xml, .mxl)"

    def import_paths(self, lib, paths):
        files = []
        imported, skipped, had = [], 0, 0
        for p in paths:
            p = Path(p)
            if not p.exists():
                raise FileNotFoundError(f"{p} not found")
            if p.is_dir():
                files += [f for f in sorted(p.rglob("*")) if f.is_file() and f.suffix.lower() in EXTENSIONS]
            elif p.suffix.lower() in EXTENSIONS:
                files.append(p)
            else:
                print(f"skipped {p}: not a MusicXML file (.musicxml, .xml, .mxl)")
                skipped += 1
        for file in files:
            sha = _sha(file)
            score_id = f"local:{sha}"
            row = lib.get(score_id)
            if row and row["file_path"] and (lib.data_dir / row["file_path"]).exists():
                print(f"already in library: #{row['num']} {row['title']}")
                had += 1
                continue
            try:
                a = analyse_file(file)
            except AnalysisError as e:
                print(f"skipped {file}: {e}")
                skipped += 1
                continue
            dest = files_dir(lib.data_dir, "local") / f"{sha}{file.suffix.lower()}"
            shutil.copyfile(file, dest)
            lib.upsert_catalogue([{
                "id": score_id,
                "source": "local",
                "title": a.title or file.stem,
                "composer": a.composer,
                "source_ref": str(file.resolve()),
                "license_conflict": 0,
                "attribution": a.composer,
            }])
            d = score_difficulty(a, None)
            lib.update_analysis(
                score_id,
                file_path=dest.relative_to(lib.data_dir).as_posix(),
                key=a.key,
                time_signature=a.time_signature,
                seconds=a.seconds,
                n_notes=a.n_notes,
                piano_only=a.piano_only,
                difficulty=d,
            )
            row = lib.get(score_id)
            print(f"imported #{row['num']} {row['title']} ({a.key or '?'}, {a.time_signature or '?'}, difficulty {d or '?'})")
            imported.append(score_id)
        print(f"Imported {len(imported)}, skipped {skipped}, already had {had}.")
        return imported

    def search(self, lib, text, *, difficulty=None, key=None, time_signature=None, limit=50):
        # Local files are already in the library, so there is nothing extra to find.
        return []

    def download(self, lib, ids, progress=None):
        for i in ids:
            print(f"{i} is a local import; nothing to download")
        return []
