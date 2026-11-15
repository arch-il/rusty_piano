import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bench_evidence import build_dataset, run_evidence  # noqa: E402
from evidence_fixtures import make_attempt, make_steps, write_attempts  # noqa: E402
from test_ear import ear_attempt  # noqa: E402
from test_sight import sight_attempt, sight_step  # noqa: E402

GOLDEN = Path(__file__).parent / "fixtures" / "evidence_golden_rich.json"


def _clean(ev):
    ev = dict(ev)
    ev.pop("generated_at")
    return json.loads(json.dumps(ev))


def build_rich_dataset(folder):
    build_dataset(folder, 30, 60)
    onsets = [0, 500, 1000, 1700, 2000, 2500, 3050, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500]
    steps = make_steps(["hit"] * len(onsets))
    for i, step in enumerate(steps):
        step["played"][0]["page_ms"] = onsets[i]
    extra = [
        make_attempt(
            id=f"attempt-2026111{k}-090000-scale0{k}",
            score="scales:c-major-1oct-rh",
            drill_id="sc.c1",
            started_at=f"2026-11-1{k}T09:00:00+00:00",
            steps=steps,
        )
        for k in range(3)
    ]
    for k in range(3):
        extra.append(
            sight_attempt(
                id=f"attempt-2026111{k}-200000-sight0{k}",
                started_at=f"2026-11-1{k}T20:00:00.000Z",
                steps=[sight_step(i, 900 + 100 * i + 50 * k, first_try=(i + k) % 3 != 0) for i in range(3)],
            )
        )
    for k in range(3):
        extra.append(
            ear_attempt(
                f"attempt-2026111{k}-100000-ear00{k}",
                f"2026-11-1{k}T10:00:00+00:00",
                results=["hit", "wrong", "hit", "hit"][: 3 + k % 2] + ["hit"] * 2,
                responses=[1000.0 + 100 * i + 30 * k for i in range(5 + k % 2)],
            )
        )
    odd = make_steps(["hit", "late", "missed", "hit", "early", "wrong", "hit", "hit"])
    random.Random(5).shuffle(odd)
    for s in odd[:3]:
        s.pop("cycle")
    odd[0]["cycle"] = 2
    extra.append(
        make_attempt(
            id="attempt-20261112-110000-odd001",
            score="piece-a",
            started_at="2026-11-12T11:00:00+00:00",
            steps=odd,
        )
    )
    write_attempts(Path(folder) / "attempts", extra)


def test_matches_rich_golden(tmp_path):
    build_rich_dataset(tmp_path)
    got = _clean(run_evidence(tmp_path))
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert golden["drills"]["sc.c1"]["evenness"] is not None
    assert got == golden


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        build_rich_dataset(tmp)
        GOLDEN.write_text(json.dumps(_clean(run_evidence(tmp)), indent=1, sort_keys=True), encoding="utf-8")
