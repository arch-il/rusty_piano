import socket
import zipfile
from pathlib import Path

import pytest

CONTAINER_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    "<container><rootfiles>"
    '<rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>'
    "</rootfiles></container>"
)


@pytest.fixture(autouse=True)
def isolate_library(tmp_path, monkeypatch):
    monkeypatch.setenv("RUSTY_PIANO_SCORES_DIR", str(tmp_path / "default_scores"))
    monkeypatch.setenv("RUSTY_PIANO_DATA_DIR", str(tmp_path / "default_data"))

    def no_network(self, *args, **kwargs):
        raise RuntimeError("network disabled in tests")

    monkeypatch.setattr(socket.socket, "connect", no_network)


@pytest.fixture
def fixtures_dir() -> Path:
    return Path(__file__).parent / "fixtures"


@pytest.fixture
def make_mxl():
    def make(src: Path, dest: Path) -> Path:
        with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("META-INF/container.xml", CONTAINER_XML)
            zf.writestr("score.musicxml", Path(src).read_bytes())
        return dest

    return make
