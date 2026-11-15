import json
from pathlib import Path

import pytest
from bench_evidence import build_dataset, run_evidence

GOLDEN = Path(__file__).parent / "fixtures" / "evidence_golden.json"


def _clean(ev):
    ev = dict(ev)
    ev.pop("generated_at")
    return json.loads(json.dumps(ev))


@pytest.fixture(scope="module")
def data(tmp_path_factory):
    folder = tmp_path_factory.mktemp("speed")
    build_dataset(folder, 80, 120)
    return folder


def test_matches_golden(data):
    got = _clean(run_evidence(data))
    assert got["habits"]
    assert got == json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_warm_run_equals_cold_run(tmp_path):
    build_dataset(tmp_path, 30, 60)
    cold = _clean(run_evidence(tmp_path))
    assert (tmp_path / "attempts" / ".cache").is_dir()
    assert _clean(run_evidence(tmp_path)) == cold
