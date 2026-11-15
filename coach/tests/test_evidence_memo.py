import contextlib
import gc
import json
import sys
from datetime import timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bench_evidence import run_evidence  # noqa: E402
from evidence_fixtures import make_attempt  # noqa: E402
from test_evidence_rich_golden import build_rich_dataset  # noqa: E402

from rusty_piano_coach import runs  # noqa: E402


def _clean(ev):
    ev = dict(ev)
    ev.pop("generated_at")
    return json.loads(json.dumps(ev))


def _run():
    return runs.runs_of_attempt(make_attempt(), timezone.utc)[0]


def test_run_accuracy_is_memoised_inside_block():
    run = _run()
    with runs.memoised():
        a1 = runs.run_accuracy(run)
        run.steps[0]["result"] = "wrong"
        assert runs.run_accuracy(run) == a1 == 1.0
    assert runs.run_accuracy(run) == 15 / 16


def test_bar_stats_memo_identity():
    rs = [_run()]
    with runs.memoised():
        assert runs.bar_stats(rs) is runs.bar_stats(rs)
    first = runs.bar_stats(rs)
    second = runs.bar_stats(rs)
    assert first == second
    assert first is not second


def test_nested_memo_keeps_outer():
    run = _run()
    with runs.memoised():
        with runs.memoised():
            a = runs.bar_stats([run])
        assert runs.bar_stats([run]) is a
    assert runs.bar_stats([run]) is not a


def test_evidence_equal_with_memo_off(tmp_path, monkeypatch):
    build_rich_dataset(tmp_path)
    ev1 = _clean(run_evidence(tmp_path))
    monkeypatch.setattr(runs, "memoised", contextlib.nullcontext)
    ev2 = _clean(run_evidence(tmp_path))
    assert ev1 == ev2


def test_gc_enabled_after_build(tmp_path):
    build_rich_dataset(tmp_path)
    run_evidence(tmp_path)
    assert gc.isenabled() is True
