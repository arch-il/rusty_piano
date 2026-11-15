import os
from pathlib import Path

DATA_DIR_ENV = "RUSTY_PIANO_SCORES_DIR"


def default_data_dir() -> Path:
    return Path(__file__).resolve().parents[3] / "data" / "scores"


def resolve_data_dir(cli_value: str | None = None) -> Path:
    value = cli_value or os.environ.get(DATA_DIR_ENV) or default_data_dir()
    return Path(value).expanduser().resolve()


def source_dir(data_dir: Path, source: str) -> Path:
    path = Path(data_dir) / "sources" / source
    path.mkdir(parents=True, exist_ok=True)
    return path


def library_file(data_dir: Path, file_path: str) -> Path:
    root = (Path(data_dir) / "files").resolve()
    full = (Path(data_dir) / file_path).resolve()
    if full == root or not full.is_relative_to(root):
        raise ValueError("The score file is outside the library files folder, so it was not removed.")
    if full.exists() and not full.is_file():
        raise ValueError("The score path is not a file, so it was not removed.")
    return full


def remove_library_file(data_dir: Path, file_path: str) -> bool:
    full = library_file(data_dir, file_path)
    if full.is_file():
        full.unlink()
        return True
    return False


def files_dir(data_dir: Path, source: str) -> Path:
    path = Path(data_dir) / "files" / source
    path.mkdir(parents=True, exist_ok=True)
    return path
