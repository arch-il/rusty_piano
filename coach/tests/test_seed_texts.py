from rusty_piano_coach import plan

seed = plan.load_json(plan.SEED_TREE)
idx = plan.drill_index(seed)

OLD_R14 = "Follow the signs: repeat, take the right ending, jump back and stop where it says."
R4_READ = "Read it from the landmarks (bass F, middle C, treble G), don't memorise it: one slow try, then move on."
M5 = "Twelve bars: four of C7, two of F7, two of C7, then G7, F7, C7, G7."

GOALS = {
    "r14.repeat": "Play to the end repeat sign, go back to the start and play the bars a second time.",
    "r14.endings": "Play ending 1 the first time; after the repeat skip it and play ending 2.",
    "r14.dc-fine": "At D.C. al Fine go back to the start and stop at Fine.",
    "r14.ds-coda": "At D.S. al Coda go back to the sign, play to To Coda, then jump to the Coda.",
    "r4.middle-c": "Middle C is the same key in both clefs: one ledger line below the treble staff or above the bass staff.",
    "r4.read-1": R4_READ,
    "r4.read-2": R4_READ,
    "r4.read-3": R4_READ,
    "r4.landmarks": "Find your place from the landmark notes: middle C, treble G, bass F.",
    "m5.blues-scale-rh": "C blues scale: C, E flat, F, F sharp, G, B flat, C; keep every note even up and down.",
    "m5.riff-rh": "Swing the riff long-short and play it the same way every time it comes back.",
    "m4.sevenths-c": "Read each chord symbol; C stays at the bottom and only the notes that change move, by a half step.",
    "t6.syncopation": "Play the quarter note off the beat and hold it through the next beat; count 1-and 2-and.",
    "s2.a-natural-rh": "Even notes; natural minor keeps the key signature: no raised 6th or 7th.",
    "s2.a-natural-lh": "Even notes; natural minor keeps the key signature: no raised 6th or 7th.",
    "s2.a-harmonic-rh": "Even notes; in harmonic minor raise the 7th (G sharp in A minor) both up and down.",
    "s2.a-harmonic-lh": "Even notes; in harmonic minor raise the 7th (G sharp in A minor) both up and down.",
    "ear.updown-2": "Hear whether the second note is a step or a skip away, up or down, and play it; aim for 90% first try.",
}


def goal(drill_id):
    return idx[drill_id][1]["goal"]


def test_exact_goals():
    for drill_id, text in GOALS.items():
        assert goal(drill_id) == text, drill_id


def test_r14_goals_differ():
    goals = [goal(d) for d in ("r14.repeat", "r14.endings", "r14.dc-fine", "r14.ds-coda")]
    assert len(set(goals)) == 4
    assert all(d[1]["goal"] != OLD_R14 for d in idx.values())


def test_m5_blues_keep_twelve_bar_goal():
    assert goal("m5.blues-lh") == M5
    assert goal("m5.blues-melody") == M5


def test_s2_melodic_word():
    for d in ("s2.a-natural-rh", "s2.a-natural-lh", "s2.a-harmonic-rh", "s2.a-harmonic-lh"):
        assert "melodic" not in goal(d)
    melodic = [d for d in idx if d.startswith("s2.a-melodic")]
    assert melodic
    for d in melodic:
        assert "melodic" in goal(d)


def test_ear_updown_goals_differ():
    assert goal("ear.updown-2") != goal("ear.updown-1")


def test_together_tempos():
    assert idx["piece.minuet-in-g-together"][1]["tempo"] == 70
    others = [d for k, (n, d) in idx.items() if k.endswith("-together") and k != "piece.minuet-in-g-together"]
    assert others
    assert all(d["tempo"] == 100 for d in others)
