from datetime import timezone

import evidence_fixtures as fx
from rusty_piano_coach import habits
from rusty_piano_coach import runs as runs_mod

NEW_IDS = ["rests_not_counted", "rhythm_consistently_wrong", "repeats_not_followed"]


def runs_of(attempts):
    return runs_mod.load_runs(attempts, timezone.utc)


def run_detect(attempts, reports=(), tree=None, state=None, keys=None):
    return habits.detect(runs_of(attempts), attempts, list(reports), tree, state, keys or {})


def ids(found):
    return [c["id"] for c in found]


def att(n, **kw):
    kw.setdefault("id", f"attempt-20261101-1000{n:02d}-aaaaaa")
    return fx.make_attempt(**kw)


def pick(found, cid):
    return [c for c in found if c["id"] == cid]


def rest_steps(length_q=1.0, early=-150.0):
    steps = fx.make_steps(["hit"] * 16, offsets=[0.0] * 16)
    for i, s in enumerate(steps):
        s["time_q"] = float(i + 2 * (i // 4))
        if length_q is not None:
            s["length_q"] = length_q
        if i in (4, 8, 12):
            s["offset_ms"] = early
            s["outcome"] = "early"
            s["result"] = "early"
    return steps


def rests_attempts(count=3, length_q=1.0, early=-150.0, **kw):
    return [att(i, score="s1", steps=rest_steps(length_q, early), **kw) for i in range(count)]


def test_rests_positive():
    found = pick(run_detect(rests_attempts()), "rests_not_counted")
    assert len(found) == 1
    assert found[0]["detail"]["samples"] == 9
    assert found[0]["detail"]["basis"] == "note_length"
    assert found[0]["where"]["bars"] == [2, 3, 4]


def test_rests_gap_basis():
    found = pick(run_detect(rests_attempts(length_q=None)), "rests_not_counted")
    assert len(found) == 1
    assert found[0]["detail"]["basis"] == "gap"


def test_rests_negatives():
    assert not pick(run_detect(rests_attempts(early=0.0)), "rests_not_counted")
    assert not pick(run_detect(rests_attempts(length_q=3.0)), "rests_not_counted")
    assert not pick(run_detect(rests_attempts(mode="wait")), "rests_not_counted")
    assert not pick(run_detect(rests_attempts(count=2)), "rests_not_counted")


def rhythm_steps(off=150.0, outcome="late"):
    steps = fx.make_steps(["hit"] * 16, offsets=[0.0] * 16)
    steps[6]["offset_ms"] = off
    steps[6]["outcome"] = outcome
    steps[6]["result"] = outcome
    return steps


def test_rhythm_positive():
    attempts = [att(i, score="s1", steps=rhythm_steps()) for i in range(3)]
    found = pick(run_detect(attempts), "rhythm_consistently_wrong")
    assert len(found) == 1
    assert found[0]["where"]["bars"] == [2]
    spot = found[0]["detail"]["spots"][0]
    assert spot["bar"] == 2
    assert spot["beat"] == 2
    assert spot["runs"] == 3


def test_rhythm_negatives():
    two = [att(i, score="s1", steps=rhythm_steps()) for i in range(2)]
    assert not pick(run_detect(two), "rhythm_consistently_wrong")
    mixed = [
        att(0, score="s1", steps=rhythm_steps()),
        att(1, score="s1", steps=rhythm_steps()),
        att(2, score="s1", steps=rhythm_steps(-150.0, "early")),
    ]
    assert not pick(run_detect(mixed), "rhythm_consistently_wrong")


def test_rhythm_weak_run_blocks():
    attempts = [
        att(0, score="s1", steps=rhythm_steps(150.0)),
        att(1, score="s1", steps=rhythm_steps(30.0)),
        att(2, score="s1", steps=rhythm_steps(150.0)),
    ]
    assert not pick(run_detect(attempts), "rhythm_consistently_wrong")


BARS = [1, 1, 2, 2, 1, 1, 2, 2, 3, 3]


def repeat_steps(wrong=(4,)):
    results = ["hit"] * 10
    for i in wrong:
        results[i] = "wrong"
    return fx.make_steps(results, bar_of=lambda i: BARS[i])


def test_repeats_positive():
    attempts = [att(i, score="s1", steps=repeat_steps()) for i in range(3)]
    found = pick(run_detect(attempts), "repeats_not_followed")
    assert len(found) == 1
    assert found[0]["where"]["bars"] == [1]
    jump = found[0]["detail"]["jumps"][0]
    assert jump["from_bar"] == 2
    assert jump["to_bar"] == 1
    assert jump["reached"] == 3
    assert jump["failed"] == 3
    assert jump["control_error_rate"] == 0.0


def test_repeats_negatives():
    clean = [att(i, score="s1", steps=repeat_steps(())) for i in range(3)]
    assert not pick(run_detect(clean), "repeats_not_followed")
    two = [att(i, score="s1", steps=repeat_steps()) for i in range(2)]
    assert not pick(run_detect(two), "repeats_not_followed")
    hard = [att(i, score="s1", steps=repeat_steps((1, 4, 5))) for i in range(3)]
    assert not pick(run_detect(hard), "repeats_not_followed")


def test_existing_fixtures_stay_quiet():
    attempts = [att(i, score="s1", steps=fx.make_steps(["hit"] * 32)) for i in range(5)]
    found = ids(run_detect(attempts))
    for cid in NEW_IDS:
        assert cid not in found


def test_titles():
    for cid in NEW_IDS:
        assert cid in habits.TITLES
