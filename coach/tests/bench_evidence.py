"""Benchmark for `coach evidence`: python tests/bench_evidence.py [--attempts 2000] [--steps 400].

Builds a seeded synthetic data dir in a temp folder and prints cold-run and warm-run seconds of build_evidence.
build_dataset is also used by test_evidence_speed.py for the golden test.

Measured 2026-11-15 on a busy 16 GB Windows machine (noisy, +-15%):
- 1000 x 400: before (v1 JSON cache) cold 36.1 s, warm 10.2 s, cache 76 MB;
  after (v2 marshal cache, run memo, detector fast paths) cold 29.6 s, warm 4.7 s, cache 51 MB (about 2.2x warm).
- 2000 x 400: before cold 64.5 s, warm 15.3 s, cache 152 MB; after cold 55.1 s, warm 11.8-14.0 s, cache 102 MB
  (only about 1.1-1.3x warm: the same Python operations cost 2-3x more per call at this size, peak working set 0.9 GB,
  no paging; detection in habits.py is about 75% of the warm run)."""

import argparse
import json
import random
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from evidence_fixtures import make_attempt, make_steps, note_on, tiny_tree, write_attempts  # noqa: E402

UTC = timezone.utc
SCORES = ["gen:t1-quarters-rh", "piece-a", "piece-b", "gen:r1-all-cs", "piece-c"]


def _layout(rng, n):
    free = list(range(3, n - 1))
    rng.shuffle(free)
    rests = set(free[: max(2, n // 20)])
    rhythm = {i: rng.choice((-150.0, 150.0)) for i in free[len(rests) : len(rests) + max(2, n // 25)]}
    hard = {rng.randrange(1, max(2, n // 4)) for _ in range(max(2, n // 40))}
    return {"rests": rests, "rhythm": rhythm, "hard_bars": hard, "jump": n // 3}


def _one_cycle(rng, lay, n, mode, cycle):
    jump = lay["jump"]
    bars = [i // 4 + 1 if i < jump else 2 + (i - jump) // 4 for i in range(n)]
    results = []
    offsets = []
    for i in range(n):
        off = rng.gauss(0, 20)
        if i in lay["rests"]:
            off = rng.gauss(-100, 10)
        elif i in lay["rhythm"]:
            off = lay["rhythm"][i] + rng.gauss(0, 10)
        elif bars[i] in lay["hard_bars"]:
            off += 70
        r = rng.random()
        if i == jump:
            result = "missed" if r < 0.8 else "hit"
        elif bars[i] in lay["hard_bars"] and r < 0.45:
            result = rng.choice(("wrong", "missed", "short"))
        elif r < 0.02:
            result = "wrong"
        else:
            result = "hit" if abs(off) < 50 else ("early" if off < 0 else "late")
        results.append(result)
        offsets.append(off)
    steps = make_steps(results, cycle=cycle, bar_of=lambda i: bars[i], offsets=offsets)
    q = 0.0
    for i, s in enumerate(steps):
        q += 3.0 if i in lay["rests"] else 1.0
        s["time_q"] = q
        s["step"] = i
        if mode == "wait":
            s["offset_ms"] = None
            for p in s["played"]:
                p["offset_ms"] = None
    return steps


def build_dataset(folder, attempts, steps, seed=1):
    rng = random.Random(seed)
    layouts = {sid: _layout(rng, steps) for sid in SCORES}
    start = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)
    out = []
    for k in range(attempts):
        sid = SCORES[k % len(SCORES)]
        mode = "wait" if sid == "gen:r1-all-cs" else "live"
        loop = k % 7 == 3 and mode == "live"
        cycles = 3 if loop else 1
        n = steps // cycles if loop else steps
        lay = layouts[sid]
        if loop:
            lay = {**lay, "rests": {i for i in lay["rests"] if i < n}, "rhythm": {i: v for i, v in lay["rhythm"].items() if i < n}, "jump": n // 3}
        all_steps = []
        for c in range(1, cycles + 1):
            all_steps += _one_cycle(rng, lay, n, mode, c)
        begin = start + timedelta(minutes=10 * k)
        ranged = k % 40 == 11
        events = [note_on(rng.randrange(40, 100), t=i * 10) for i in range(len(all_steps))] if k % 2 else []
        if events:
            events.append({"type": "note_off", "source": "engine", "note": 60, "t": 5, "page_ms": 5})
        attempt = make_attempt(
            id=f"attempt-20261001-{k:06d}",
            score=sid,
            mode=mode,
            steps=all_steps,
            events=events,
            loop=loop,
            loops_completed=cycles if loop else 0,
            steps_total=n if loop else len(all_steps),
            started_at=begin.isoformat(),
            end="stop" if k % 9 == 5 else "done",
            tempo_percent=100 if k % 4 else 80,
            last_bar=max(s["bar"] for s in all_steps),
        )
        attempt["saved_at"] = (begin + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        if ranged:
            attempt["practice"]["range"] = {"from": 1, "to": 2}
        out.append(attempt)
    write_attempts(Path(folder) / "attempts", out)
    plan_dir = Path(folder) / "plan"
    plan_dir.mkdir(parents=True, exist_ok=True)
    (plan_dir / "tree.json").write_text(json.dumps(tiny_tree()), encoding="utf-8")
    (Path(folder) / "reports").mkdir(exist_ok=True)
    (Path(folder) / "scores").mkdir(exist_ok=True)


def run_evidence(folder):
    from rusty_piano_coach import trends

    folder = Path(folder)
    return trends.build_evidence(
        attempts_dir=folder / "attempts",
        reports_dir=folder / "reports",
        plan_dir=folder / "plan",
        scores_dir=folder / "scores",
        since=None,
        today=date(2026, 12, 1),
        tz=UTC,
        now=datetime(2026, 12, 1, 12, 0, tzinfo=UTC),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--attempts", type=int, default=2000)
    ap.add_argument("--steps", type=int, default=400)
    args = ap.parse_args()
    from rusty_piano_coach import attempt_cache

    with tempfile.TemporaryDirectory() as tmp:
        build_dataset(tmp, args.attempts, args.steps)
        for label in ("cold", "warm", "warm"):
            t = time.perf_counter()
            ev = run_evidence(tmp)
            print(f"{label}: {time.perf_counter() - t:.2f}s  habits={len(ev['habits'])}")
        cache = Path(tmp) / "attempts" / ".cache" / attempt_cache.CACHE_FILE
        print(f"cache size: {cache.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
