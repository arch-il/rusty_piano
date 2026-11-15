from datetime import timezone

import evidence_fixtures as fx
from rusty_piano_coach import habits
from rusty_piano_coach import runs as runs_mod


def runs_of(attempts):
    return runs_mod.load_runs(attempts, timezone.utc)


def run_detect(attempts, reports=(), tree=None, state=None, keys=None):
    return habits.detect(runs_of(attempts), attempts, list(reports), tree, state, keys or {})


def ids(found):
    return [c["id"] for c in found]


def att(n, **kw):
    kw.setdefault("id", f"attempt-20261101-1000{n:02d}-aaaaaa")
    return fx.make_attempt(**kw)


def long_steps(results=None, bars=8):
    results = results or ["hit"] * (bars * 4)
    return fx.make_steps(results)


def test_parse_key():
    assert habits.parse_key("G major") == 1
    assert habits.parse_key("F major") == -1
    assert habits.parse_key("B- major") == -2
    assert habits.parse_key("E minor") == 1
    assert habits.parse_key("nonsense") is None


def test_fun_only_gives_nothing():
    attempts = [att(i, score="s1", tags=["fun"], steps=long_steps(["wrong"] * 32)) for i in range(6)]
    assert habits.detect([r for r in runs_of(attempts) if r.counted], attempts, [], None, None, {}) == []


# 1
def test_start_at_bar_1_positive():
    attempts = [att(i, score="s1", steps=long_steps()) for i in range(5)]
    found = run_detect(attempts)
    assert ids(found) == ["start_at_bar_1"]
    assert found[0]["detail"]["attempts"] == 5


def test_start_at_bar_1_negative():
    attempts = [att(i, score="s1", steps=long_steps(), range={"from": 4, "to": 8}) for i in range(5)]
    assert "start_at_bar_1" not in ids(run_detect(attempts))
    gen = [att(i, steps=long_steps()) for i in range(5)]
    assert "start_at_bar_1" not in ids(run_detect(gen))


# 2
def hard_bar_steps():
    return fx.make_steps(["wrong", "wrong", "hit", "hit"] + ["hit"] * 28)


def test_plays_through_mistakes_positive():
    attempts = [att(i, score="s1", steps=hard_bar_steps()) for i in range(4)]
    found = [c for c in run_detect(attempts) if c["id"] == "plays_through_mistakes"]
    assert found and found[0]["where"]["bars"] == [1]


def test_plays_through_mistakes_negative():
    attempts = [att(i, score="s1", steps=hard_bar_steps()) for i in range(4)]
    attempts.append(att(9, score="s1", steps=hard_bar_steps()[:4], range={"from": 1, "to": 2}))
    assert "plays_through_mistakes" not in ids(run_detect(attempts))


# 3
def tempo_attempts(accuracy_results):
    out = [att(i, tempo_percent=120, steps=fx.make_steps(accuracy_results)) for i in range(4)]
    out.append(att(7, tempo_percent=80, steps=fx.make_steps(["hit"] * 16)))
    return out


def test_tempo_too_high_positive():
    found = run_detect(tempo_attempts(["hit"] * 10 + ["wrong"] * 6), tree=fx.tiny_tree())
    item = [c for c in found if c["id"] == "tempo_too_high"][0]
    assert item["detail"]["tempo_percent"] == 120
    assert item["detail"]["lower_tempo_accuracy"] == 1.0


def test_tempo_too_high_negative():
    assert "tempo_too_high" not in ids(run_detect(tempo_attempts(["hit"] * 16), tree=fx.tiny_tree()))


# 4
def node_attempts(counts):
    out = []
    n = 0
    for drill, count in counts.items():
        for _ in range(count):
            n += 1
            out.append(att(n, drill_id=drill, score=f"gen:{drill}"))
    return out


def test_avoids_weak_node_positive():
    state = {"nodes": {"T1": {"level": 2}}}
    found = run_detect(node_attempts({"t1.q": 8}), tree=fx.tiny_tree(), state=state)
    item = [c for c in found if c["id"] == "avoids_weak_node"][0]
    assert item["where"]["node"] == "T2"
    assert item["detail"]["weak_nodes"] == {"T2": 0, "R1": 0} or "T2" in item["detail"]["weak_nodes"]


def test_avoids_weak_node_negative():
    state = {"nodes": {"T1": {"level": 2}}}
    found = run_detect(node_attempts({"t1.q": 6, "t2.h": 2, "r1.c": 1}), tree=fx.tiny_tree(), state=state)
    assert "avoids_weak_node" not in ids(found)
    assert "avoids_weak_node" not in ids(run_detect(node_attempts({"t1.q": 8}), tree=None))


# 5
def stop_attempts(n, bar_steps):
    return [att(i, score="s1", end="stop", steps=fx.make_steps(bar_steps)) for i in range(n)]


def test_restarts_same_spot_positive():
    found = run_detect(stop_attempts(3, ["hit"] * 6 + ["pending"] * 4))
    item = [c for c in found if c["id"] == "restarts_same_spot"][0]
    assert item["where"]["bars"] == [2]


def test_restarts_same_spot_negative():
    assert "restarts_same_spot" not in ids(run_detect(stop_attempts(2, ["hit"] * 6)))
    loops = [att(i, score="s1", end="stop", loop=True, steps=fx.make_steps(["hit"] * 6)) for i in range(3)]
    assert "restarts_same_spot" not in ids(run_detect(loops))


# 6
def rush_steps():
    steps = fx.make_steps((["wrong"] + ["hit"] * 7) * 2, offsets=[0.0] * 16)
    for i, s in enumerate(steps):
        if s["outcome"] == "hit" and not s["wrong"]:
            s["offset_ms"] = -80.0 if i % 8 < 4 else 80.0
    return steps


def test_rushing_after_mistakes_positive():
    attempts = [att(i, steps=rush_steps()) for i in range(2)]
    found = [c for c in run_detect(attempts) if c["id"] == "rushing"]
    assert found and found[0]["detail"]["kind"] == "after_mistakes"


def test_rushing_negative():
    attempts = [att(i, steps=fx.make_steps(["wrong", "hit", "hit", "hit"] * 4)) for i in range(2)]
    assert "rushing" not in ids(run_detect(attempts))
    assert "rushing" not in ids(run_detect([], reports=[fx.make_report(drift=0.1)] * 3))


def test_rushing_speeding_up_positive():
    found = run_detect([], reports=[fx.make_report(drift=1.0)] * 3)
    assert found[0]["detail"]["kind"] == "speeding_up"
    assert found[0]["detail"]["reports"] == 3


# 7
def slow_steps():
    steps = fx.make_steps(["wrong"] * 4 + ["hit"] * 12)
    for s in steps[4:]:
        s["offset_ms"] = 0.0
    for s in steps[:4]:
        s["offset_ms"] = 100.0
    return steps


def test_slows_at_hard_bars_positive():
    attempts = [att(i, score="s1", steps=slow_steps()) for i in range(4)]
    found = [c for c in run_detect(attempts) if c["id"] == "slows_at_hard_bars"]
    assert found and found[0]["where"]["bars"] == [1]


def test_slows_at_hard_bars_negative():
    steps = slow_steps()
    for s in steps:
        s["offset_ms"] = 0.0
    attempts = [att(i, score="s1", steps=steps) for i in range(4)]
    assert "slows_at_hard_bars" not in ids(run_detect(attempts))


# 8
def test_cuts_long_notes_positive():
    attempts = [att(i, steps=fx.make_steps(["short", "short", "hit", "hit"] * 2)) for i in range(2)]
    found = [c for c in run_detect(attempts) if c["id"] == "cuts_long_notes"]
    assert found and found[0]["where"]["bars"] == [1, 2]


def test_cuts_long_notes_negative():
    attempts = [att(i, steps=fx.make_steps(["hit"] * 16)) for i in range(2)]
    assert "cuts_long_notes" not in ids(run_detect(attempts))
    few = [att(1, steps=fx.make_steps(["short"] * 4))]
    assert "cuts_long_notes" not in ids(run_detect(few))


# 9
def lh_report(lag):
    notes = []
    for q in range(8):
        notes.append({"kind": "match", "part": 0, "score_q": q, "loop": 0, "offset_ms": 0.0})
        notes.append({"kind": "match", "part": 1, "score_q": q, "loop": 0, "offset_ms": lag})
    return fx.make_report(notes=notes)


def test_left_hand_late_positive():
    found = run_detect([], reports=[lh_report(50.0)])
    assert found[0]["id"] == "left_hand_late"
    assert found[0]["detail"]["groups"] == 8


def test_left_hand_late_negative():
    assert run_detect([], reports=[lh_report(5.0)]) == []


# 10
def vel_attempt(values):
    return att(1, events=[fx.note_on(v) for v in values])


def test_flat_dynamics_positive():
    found = run_detect([vel_attempt([64] * 60)])
    assert ids(found) == ["flat_dynamics"]
    assert found[0]["where"]["score"] is None


def test_flat_dynamics_negative():
    assert run_detect([vel_attempt([40, 90] * 30)]) == []
    assert run_detect([vel_attempt([64] * 10)]) == []


# 11
def wrong_attempts(pitches):
    return [att(i, score="s1", steps=fx.make_steps(["wrong"]), expected=60) for i in range(len(pitches))]


def test_same_wrong_pitch_positive():
    attempts = wrong_attempts([61] * 3)
    found = [c for c in run_detect(attempts) if c["id"] == "same_wrong_pitch"]
    assert found and found[0]["detail"]["played"] == 61
    assert found[0]["detail"]["attempts"] == 3


def test_same_wrong_pitch_negative():
    assert "same_wrong_pitch" not in ids(run_detect(wrong_attempts([61] * 2)))
    attempts = wrong_attempts([61] * 3)
    for i, a in enumerate(attempts):
        a["steps"][0]["wrong"][0]["note"] = 61 + i
    assert "same_wrong_pitch" not in ids(run_detect(attempts))


# 12
def key_attempts(played_delta, expected=66):
    out = []
    for i in range(3):
        steps = fx.make_steps(["wrong"], expected=expected)
        steps[0]["wrong"][0]["note"] = expected + played_delta
        out.append(att(i, score="s1", steps=steps))
    return out


def test_key_signature_semitone_positive():
    found = run_detect(key_attempts(-1), keys={"s1": "G major"})
    item = [c for c in found if c["id"] == "key_signature_semitone"][0]
    assert item["detail"]["fifths"] == 1
    assert item["detail"]["examples"][0] == {"bar": 1, "expected": 66, "played": 65}


def test_key_signature_semitone_negative():
    assert "key_signature_semitone" not in ids(run_detect(key_attempts(-1), keys={"s1": "C major"}))
    assert "key_signature_semitone" not in ids(run_detect(key_attempts(-1), keys={"s1": None}))
    assert "key_signature_semitone" not in ids(run_detect(key_attempts(1), keys={"s1": "G major"}))
