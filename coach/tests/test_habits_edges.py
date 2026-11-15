import evidence_fixtures as fx
import pytest
from test_habits_more import att, pick, run_detect

CID = "rhythm_consistently_wrong"


def edge_steps(index, off=150.0):
    steps = fx.make_steps(["hit"] * 16, offsets=[0.0] * 16)
    steps[index].update(offset_ms=off, outcome="late", result="late")
    return steps


def flagged(steps_fn, n=3):
    return pick(run_detect([att(i, score="s1", steps=steps_fn()) for i in range(n)]), CID)


@pytest.mark.parametrize("index,bar,beat", [(1, 1, 1), (2, 1, 2), (14, 4, 2), (15, 4, 3)])
def test_lone_late_at_edges_flags(index, bar, beat):
    found = flagged(lambda: edge_steps(index))
    assert len(found) == 1
    spots = found[0]["detail"]["spots"]
    assert len(spots) == 1
    assert (spots[0]["bar"], spots[0]["beat"]) == (bar, beat)
    assert spots[0]["runs"] == 3
    assert spots[0]["mean_ms"] == 150.0


def test_lone_early_at_edge_flags():
    found = flagged(_early)
    assert len(found) == 1
    assert found[0]["detail"]["spots"][0]["mean_ms"] == -150.0


def _early():
    steps = edge_steps(1, -150.0)
    steps[1].update(outcome="early", result="early")
    return steps


def test_two_attempts_not_flagged():
    assert not flagged(lambda: edge_steps(1), n=2)


def _drag(per_step):
    return fx.make_steps(["hit"] * 16, offsets=[per_step * k for k in range(16)])


def test_steady_drag_not_flagged():
    assert not flagged(lambda: _drag(30.0), n=4)


def test_steep_drag_not_flagged():
    assert not flagged(lambda: _drag(100.0), n=4)


def test_phase_shift_not_flagged():
    assert not flagged(lambda: fx.make_steps(["hit"] * 16, offsets=[0.0] * 3 + [300.0] * 13))


def test_ritardando_last_steps_not_flagged():
    steps = lambda: fx.make_steps(["hit"] * 16, offsets=[0.0] * 12 + [0.0, 100.0, 200.0, 300.0])
    assert not flagged(steps, n=4)
