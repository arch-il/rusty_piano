import os
from dataclasses import dataclass
from pathlib import Path

from .difficulty import catalogue_difficulty
from .fingering import remove_sidecar
from .index import fts_query
from .paths import library_file
from .score_notes import remove_sidecar as remove_notes_sidecar


class UnsupportedCommand(Exception):
    pass


@dataclass
class SetupStep:
    id: str
    title: str
    detail: str
    needed_for: str
    done: bool


REMOVING_SUFFIX = ".removing"


def sweep_removing(lib) -> tuple[int, int]:
    """Clean up files parked by a remove that crashed: put a file back when its row still points to it, else delete it. Call only while holding the library's busy lock. Returns (restored, discarded)."""
    root = Path(lib.data_dir) / "files"
    if not root.is_dir():
        return 0, 0
    wanted = set()
    for row in lib.conn.execute("SELECT file_path FROM scores WHERE file_path IS NOT NULL"):
        try:
            wanted.add(library_file(lib.data_dir, row[0]))
        except ValueError:
            continue
    restored = discarded = 0
    for parked in sorted(root.rglob("*" + REMOVING_SUFFIX)):
        if not parked.is_file():
            continue
        original = parked.with_name(parked.name[: -len(REMOVING_SUFFIX)])
        try:
            if original.resolve() in wanted and not original.exists():
                os.replace(parked, original)
                restored += 1
            else:
                parked.unlink()
                discarded += 1
        except OSError:
            continue
    return restored, discarded


class Source:
    """Base class for score sources.

    A source plugs in by subclassing Source and being listed in all_sources(). Taking it out of
    that list takes it out of the CLI, the page search and the setup offers.

    Progress callback: progress(phase: str, done: int, total: int | None, unit: str), where unit
    is "bytes" or "items". Sources always call it with all 4 arguments positionally.

    remove(lib, id) takes a score out of the library: the file under <data_dir>/files (never
    anything outside it) is first renamed aside, then the index changes, then the file is deleted;
    a failed index change puts the file back. The index change removes the whole row (default,
    used by local imports), or, when keeps_catalogue_row is True (catalogue sources such as PDMX),
    clears only the download fields so the score stays searchable and downloadable. Each remove
    first sweeps leftover ".removing" files from a crashed remove (restored or deleted).
    """

    name = ""
    label = ""
    description = ""
    keeps_catalogue_row = False

    def remove(self, lib, score_id) -> None:
        sweep_removing(lib)
        row = lib.get(score_id)
        if row is None or row['source'] != self.name:
            raise LookupError(f"no score with id '{score_id}'")
        if not row['file_path']:
            raise ValueError('This score is not in your library.')
        full = library_file(lib.data_dir, row['file_path'])
        parked = None
        if full.is_file():
            parked = full.with_name(full.name + REMOVING_SUFFIX)
            os.replace(full, parked)
        try:
            if self.keeps_catalogue_row:
                lib.clear_download(score_id, difficulty=catalogue_difficulty(row['source_complexity'], row['n_notes'], row['seconds']))
            else:
                lib.remove_score(score_id)
        except Exception:
            if parked is not None:
                try:
                    os.replace(parked, full)
                except OSError:
                    pass
            raise
        if parked is not None:
            try:
                parked.unlink()
            except OSError:
                pass
        remove_sidecar(full)
        remove_notes_sidecar(full)

    def sync(self, lib, from_file: Path | None) -> int:
        raise UnsupportedCommand(f"source '{self.name}' has no online catalogue to sync")

    def fetch_archive(self, lib, from_file: Path | None) -> Path:
        raise UnsupportedCommand(f"source '{self.name}' has no archive to fetch")

    def download(self, lib, ids: list[str], progress=None) -> list[str]:
        raise UnsupportedCommand(f"source '{self.name}' cannot download scores")

    def setup_steps(self, lib) -> list[SetupStep]:
        return []

    def run_setup_step(self, lib, step_id, progress=None) -> str:
        raise UnsupportedCommand(f"source '{self.name}' has no setup steps")

    def search(self, lib, text, *, difficulty=None, key=None, time_signature=None, limit=50) -> list[dict]:
        if not text or not text.strip() or fts_query(text) == "":
            return []
        # key and time_signature are ignored: catalogue rows have none until downloaded.
        return lib.search(text, difficulty=difficulty, source=self.name,
                          include_conflicts=False, undownloaded=True, limit=limit)

    def import_paths(self, lib, paths: list[Path]) -> list[str]:
        raise UnsupportedCommand(f"source '{self.name}' cannot import files")


def all_sources() -> dict[str, Source]:
    from .local import LocalSource

    from .pdmx import PdmxSource

    from .gen import GenSource

    from .scales import ScalesSource

    sources = [LocalSource(), PdmxSource(), GenSource(), ScalesSource()]
    return {s.name: s for s in sources}


def get_source(name) -> Source:
    sources = all_sources()
    if name not in sources:
        raise LookupError(f"unknown source '{name}'; known: {', '.join(sorted(sources))}")
    return sources[name]
