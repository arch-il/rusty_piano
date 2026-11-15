"""Difficulty on a 1-5 scale.

score_difficulty combines five features of a parsed score, each scaled 0-1 and weighted:
notes per second (all pitches), pitch range, chord ratio, two staves (two hands), and
accidental ratio. The weighted sum becomes a level 1-5. If the source gives a MuseScore
complexity (1-3), the level is blended 70/30 with that complexity.

catalogue_difficulty estimates a level from catalogue fields only (notes per second and
complexity), for scores that have not been downloaded.

All constants below are tunable.
"""

import math

# Tunable: weights of each feature in the score-based level (they sum to 1.0).
WEIGHTS = {"nps": 0.40, "range": 0.20, "chords": 0.15, "hands": 0.15, "accidentals": 0.10}
# Tunable: notes per second at which the density feature is 0 (easy) and 1 (hard).
NPS_EASY = 2.0
NPS_HARD = 16.0
# Tunable: pitch range in semitones at which the range feature is 0 and 1.
RANGE_EASY = 12
RANGE_HARD = 48
# Tunable: chord ratio at which the chord feature reaches 1.
CHORD_FULL = 0.5
# Tunable: accidental ratio at which the accidental feature reaches 1.
ACCIDENTAL_FULL = 0.3
# Tunable: MuseScore complexity (1-3) mapped to a 1-5 level; 0 means unset.
COMPLEXITY_LEVEL = {1: 1, 2: 3, 3: 5}
# Tunable: share of the score-based level in the blend with source complexity.
SCORE_WEIGHT = 0.7


def round_half_up(x: float) -> int:
    return int(math.floor(x + 0.5))


def clamp01(x) -> float:
    return max(0.0, min(1.0, x))


def level_from_raw(raw: float) -> int:
    return 1 + round_half_up(4 * clamp01(raw))


def score_difficulty(a, source_complexity: int | None = None) -> int | None:
    if a.n_notes == 0:
        return None
    nps = a.n_notes / a.seconds if a.seconds else 0.0
    raw = (
        WEIGHTS["nps"] * clamp01((nps - NPS_EASY) / (NPS_HARD - NPS_EASY))
        + WEIGHTS["range"] * clamp01((a.pitch_range - RANGE_EASY) / (RANGE_HARD - RANGE_EASY))
        + WEIGHTS["chords"] * clamp01(a.chord_ratio / CHORD_FULL)
        + WEIGHTS["hands"] * (1.0 if a.staves >= 2 else 0.0)
        + WEIGHTS["accidentals"] * clamp01(a.accidental_ratio / ACCIDENTAL_FULL)
    )
    level = level_from_raw(raw)
    if source_complexity in COMPLEXITY_LEVEL:
        blended = SCORE_WEIGHT * level + (1 - SCORE_WEIGHT) * COMPLEXITY_LEVEL[source_complexity]
        return min(5, max(1, round_half_up(blended)))
    return level


def catalogue_difficulty(source_complexity, n_notes, seconds) -> int | None:
    lv_nps = None
    if n_notes and seconds and seconds > 0:
        lv_nps = level_from_raw((n_notes / seconds - NPS_EASY) / (NPS_HARD - NPS_EASY))
    lv_c = COMPLEXITY_LEVEL.get(source_complexity)
    if lv_nps is not None and lv_c is not None:
        return round_half_up((lv_nps + lv_c) / 2)
    if lv_nps is not None:
        return lv_nps
    return lv_c
