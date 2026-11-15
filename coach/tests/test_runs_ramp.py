from datetime import timezone

from evidence_fixtures import make_attempt, make_steps

from rusty_piano_coach import runs


def ramped_attempt(cycles, loop=True):
    a = make_attempt(
        loop=loop,
        tempo_percent=60,
        steps=make_steps(["hit"] * 4, cycle=1) + make_steps(["hit"] * 4, cycle=2) + make_steps(["hit"] * 4, cycle=3),
        steps_total=4,
    )
    a["practice"]["tempo"]["ramp"] = {
        "step_percent": 5,
        "target_percent": 100,
        "back_after_bad": 2,
        "cycles": cycles,
    }
    return a


def percents(a):
    return [r.tempo_percent for r in runs.runs_of_attempt(a, timezone.utc)]


def test_each_loop_run_takes_its_own_ramp_percent():
    a = ramped_attempt([{"cycle": 1, "percent": 60}, {"cycle": 2, "percent": 65}, {"cycle": 3, "percent": 70}])
    assert percents(a) == [60, 65, 70]


def test_without_a_ramp_every_loop_is_the_start_percent():
    a = make_attempt(
        loop=True,
        tempo_percent=60,
        steps=make_steps(["hit"] * 4, cycle=1) + make_steps(["hit"] * 4, cycle=2) + make_steps(["hit"] * 4, cycle=3),
        steps_total=4,
    )
    assert percents(a) == [60, 60, 60]


def test_ramp_none_is_the_start_percent():
    a = ramped_attempt(None)
    a["practice"]["tempo"]["ramp"] = None
    assert percents(a) == [60, 60, 60]


def test_malformed_cycle_entries_are_ignored():
    a = ramped_attempt(["x", {"cycle": "2", "percent": 65}, {"cycle": 2}, {"cycle": True, "percent": 80}])
    assert percents(a) == [60, 60, 60]


def test_a_cycle_missing_from_the_list_uses_the_start_percent():
    a = ramped_attempt([{"cycle": 2, "percent": 65}])
    assert percents(a) == [60, 65, 60]
