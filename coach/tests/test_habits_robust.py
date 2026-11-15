import evidence_fixtures as fx
from test_habits_more import att, pick, rhythm_steps, run_detect

RHY = "rhythm_consistently_wrong"
REP = "repeats_not_followed"


def loop_attempt(n, cycles, make):
    steps = []
    for c in range(1, cycles + 1):
        for s in make():
            s["cycle"] = c
            steps.append(s)
    return att(n, score="s1", steps=steps, loop=True, steps_total=len(steps) // cycles)


def test_steady_drag_not_flagged():
    """Offsets rising 15 ms per step in every run are a drag, not a wrong rhythm."""
    attempts = [att(i, score="s1", steps=fx.make_steps(["hit"] * 16, offsets=[15.0 * k for k in range(16)])) for i in range(4)]
    assert not pick(run_detect(attempts), RHY)


def test_unmarked_fermata_not_flagged():
    """Everything from bar 2 on is 300 ms later; a phase shift is not a rhythm error."""
    offs = [0.0] * 4 + [300.0] * 12
    attempts = [att(i, score="s1", steps=fx.make_steps(["hit"] * 16, offsets=offs)) for i in range(3)]
    assert not pick(run_detect(attempts), RHY)


def test_lone_late_note_flagged():
    """One note 150 ms late in the same place in 3 runs still flags that spot."""
    attempts = [att(i, score="s1", steps=rhythm_steps()) for i in range(3)]
    found = pick(run_detect(attempts), RHY)
    assert found and found[0]["detail"]["spots"][0]["bar"] == 2


def test_rhythm_counts_attempts_not_cycles():
    """One loop attempt of 5 cycles is one attempt; three attempts flag."""
    one = [loop_attempt(0, 5, rhythm_steps)]
    assert not pick(run_detect(one), RHY)
    three = [loop_attempt(i, 5, rhythm_steps) for i in range(3)]
    assert pick(run_detect(three), RHY)


def skip_steps(wrong_after=()):
    bars = [1, 1, 2, 2, 3, 3, 4, 4, 6, 6, 7, 7, 8, 8]
    results = ["hit"] * len(bars)
    for i in wrong_after:
        results[i] = "wrong"
    return fx.make_steps(results, bar_of=lambda i: bars[i])


def test_forward_skip_over_empty_bar_not_a_jump():
    """Bars 1-4 then 6-8 with bar 5 never played: not a repeat."""
    attempts = [att(i, score="s1", steps=skip_steps((8,))) for i in range(3)]
    assert not pick(run_detect(attempts), REP)


def backward_steps(wrong=(8,)):
    bars = [1, 1, 2, 2, 3, 3, 4, 4, 1, 1, 2, 2]
    results = ["hit"] * len(bars)
    for i in wrong:
        results[i] = "wrong"
    steps = fx.make_steps(results, bar_of=lambda i: bars[i])
    for s in steps[8:]:
        s["pass"] = 2
    return steps


def test_backward_jump_flags():
    """A jump from bar 4 back to bar 1 failing in 3 attempts flags."""
    attempts = [att(i, score="s1", steps=backward_steps()) for i in range(3)]
    assert pick(run_detect(attempts), REP)


def test_first_ending_skip_flags():
    """Bar 7 to 9 where bar 8 appears earlier in the run is a jump."""
    bars = [1, 1, 7, 7, 8, 8, 7, 7, 9, 9, 10, 10]
    results = ["hit"] * len(bars)
    results[8] = "wrong"
    attempts = [att(i, score="s1", steps=fx.make_steps(results, bar_of=lambda i: bars[i])) for i in range(3)]
    assert pick(run_detect(attempts), REP)


def test_repeats_counts_attempts_not_cycles():
    """One loop attempt of 5 cycles failing after a backward jump is one attempt."""
    one = [loop_attempt(0, 5, backward_steps)]
    assert not pick(run_detect(one), REP)
    three = [loop_attempt(i, 5, backward_steps) for i in range(3)]
    assert pick(run_detect(three), REP)
