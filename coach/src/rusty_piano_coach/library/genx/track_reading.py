import random

from .core import Gx, bars, walk

UP5 = ['C4', 'D4', 'E4', 'F4', 'G4']
LOW5 = ['C3', 'D3', 'E3', 'F3', 'G3']

G_R4 = 'Find your place from the landmark notes: middle C, treble G, bass F.'
G_R5 = 'Read the distance between notes from their shape: step, skip or jump.'
G_R6 = 'Count the ledger lines to find each note before you play it.'
G_R7 = 'Remember the key signature: every F is F sharp in G major, every B is B flat in F major.'
G_R8 = 'Keep going through mistakes; do not stop to fix them.'

_RHYTHMS_44 = [['q', 'q', 'q', 'q'], ['h', 'q', 'q'], ['q', 'q', 'h'], ['h', 'h'], ['e', 'e', 'q', 'h'], ['q', 'q', 'e', 'e', 'q']]
_RHYTHMS_34 = [['q', 'q', 'q'], ['h', 'q'], ['q', 'h'], ['h.'], ['e', 'e', 'q', 'q']]


def _sight(seed, scale, end, rhythms=_RHYTHMS_44, n_bars=6):
    rnd = random.Random(seed)
    pitches = walk(seed + 1, scale, 5 * n_bars)
    out, i = [], 0
    for _ in range(n_bars):
        toks = []
        for d in rnd.choice(rhythms):
            toks.append(pitches[i] if d == 'q' else pitches[i] + ':' + d)
            i += 1
        out.append(' '.join(toks))
    out.append(end)
    return ' | '.join(out)


EXERCISES = [
    Gx('r4-landmarks', 'R4 Landmark notes', 'R4', 'reading', 60,
       rh='C4:h G4:h | C5:h G4:h | r | r | C4:w',
       lh='r | r | C3:h F3:h | C3:h F3:h | r',
       hands='both', goal=G_R4),
    Gx('r4-middle-c', 'R4 Middle C in both clefs', 'R4', 'reading', 60,
       rh='C4 D4 E4 D4 | C4:w | r | r | E4 D4 C4:h',
       lh='r | r | C4 B3 A3 B3 | C4:w | r',
       hands='both', goal=G_R4),
    Gx('r4-read-1', 'R4 Reading snippet 1 (both hands)', 'R4', 'reading', 60,
       rh=bars(walk(401, UP5, 8), 4) + ' | r | r | C4:w',
       lh='r | r | ' + bars(walk(411, LOW5, 8), 4) + ' | r',
       hands='both', goal=G_R4),
    Gx('r4-read-2', 'R4 Reading snippet 2 (both hands)', 'R4', 'reading', 60,
       rh=bars(walk(402, UP5, 8), 4) + ' | r | r | C4:w',
       lh='r | r | ' + bars(walk(412, LOW5, 8), 4) + ' | r',
       hands='both', goal=G_R4),
    Gx('r4-read-3', 'R4 Reading snippet 3 (both hands)', 'R4', 'reading', 60,
       rh=bars(walk(403, UP5, 8), 4) + ' | r | r | C4:w',
       lh='r | r | ' + bars(walk(413, LOW5, 8), 4) + ' | r',
       hands='both', goal=G_R4),
    Gx('r5-seconds', 'R5 Seconds (steps)', 'R5', 'reading', 60,
       rh='C4 D4 E4 D4 | E4 F4 G4 F4 | E4 D4 C4 D4 | C4:w',
       hands='right', goal=G_R5),
    Gx('r5-thirds', 'R5 Thirds (skips)', 'R5', 'reading', 60,
       rh='C4 E4 D4 F4 | E4 G4 F4 D4 | E4 C4 D4 F4 | E4:h C4:h',
       hands='right', goal=G_R5),
    Gx('r5-fourths-fifths', 'R5 Fourths and fifths', 'R5', 'reading', 60,
       rh='C4:h F4:h | D4:h G4:h | C4:h G4:h | C4:w',
       hands='right', goal=G_R5),
    Gx('r5-intervals-lh', 'R5 Intervals (left hand)', 'R5', 'reading', 60,
       lh='C3 E3 G3 E3 | C3 D3 F3 D3 | C3:h G3:h | C3:w',
       hands='left', goal=G_R5),
    Gx('r5-read-1', 'R5 Reading snippet 1 (right hand)', 'R5', 'reading', 60,
       rh=bars(walk(501, UP5, 12, moves=(-4, -3, -2, 2, 3, 4)), 4) + ' | C4:w',
       hands='right', goal=G_R5),
    Gx('r5-read-2', 'R5 Reading snippet 2 (right hand)', 'R5', 'reading', 60,
       rh=bars(walk(502, UP5, 12, moves=(-4, -3, -2, 2, 3, 4)), 4) + ' | C4:w',
       hands='right', goal=G_R5),
    Gx('r6-high-c', 'R6 Up to high C (right hand)', 'R6', 'reading', 60,
       rh='G5 A5 B5 C6 | C6:h G5:h | A5 B5 C6:h | C6:w',
       hands='right', goal=G_R6),
    Gx('r6-below-treble', 'R6 Below the treble staff (right hand)', 'R6', 'reading', 60,
       rh='C4 B3 A3 B3 | C4 D4 E4 D4 | C4 B3 A3:h | C4:w',
       hands='right', goal=G_R6),
    Gx('r6-low-c', 'R6 Down to low C (left hand)', 'R6', 'reading', 60,
       lh='G2 F2 E2 D2 | C2:w | D2 E2 F2 G2 | C2:w',
       hands='left', goal=G_R6),
    Gx('r6-above-bass', 'R6 Above the bass staff (left hand)', 'R6', 'reading', 60,
       lh='A3 B3 C4 D4 | E4:h C4:h | D4 C4 B3 A3 | C4:w',
       hands='left', goal=G_R6),
    Gx('r6-read-1', 'R6 Reading snippet 1 (high notes)', 'R6', 'reading', 60,
       rh=bars(walk(601, ['F5', 'G5', 'A5', 'B5', 'C6'], 12), 4) + ' | C6:w',
       hands='right', goal=G_R6),
    Gx('r7-g-rh', 'R7 G major: F is F sharp (right hand)', 'R7', 'reading', 60, fifths=1,
       rh='G4 F#4 E4 D4 | E4 F#4 G4:h | A4 G4 F#4 E4 | D4 F#4 G4:h',
       hands='right', goal=G_R7),
    Gx('r7-g-lh', 'R7 G major: F is F sharp (left hand)', 'R7', 'reading', 60, fifths=1,
       lh='D3 F#3 A3 F#3 | G3 F#3 E3 D3 | E3 F#3 G3:h | G3:w',
       hands='left', goal=G_R7),
    Gx('r7-f-rh', 'R7 F major: B is B flat (right hand)', 'R7', 'reading', 60, fifths=-1,
       rh='F4 G4 A4 Bb4 | C5 Bb4 A4 G4 | A4 Bb4 C5:h | F4:w',
       hands='right', goal=G_R7),
    Gx('r7-f-lh', 'R7 F major: B is B flat (left hand)', 'R7', 'reading', 60, fifths=-1,
       lh='F2 G2 A2 Bb2 | C3 Bb2 A2 G2 | F2 A2 C3:h | F2:w',
       hands='left', goal=G_R7),
    Gx('r7-read-g', 'R7 Reading snippet in G major', 'R7', 'reading', 60, fifths=1,
       rh=bars(walk(701, ['D4', 'E4', 'F#4', 'G4', 'A4'], 12), 4) + ' | G4:w',
       hands='right', goal=G_R7),
    Gx('r7-read-f', 'R7 Reading snippet in F major', 'R7', 'reading', 60, fifths=-1,
       rh=bars(walk(702, ['F4', 'G4', 'A4', 'Bb4', 'C5'], 12), 4) + ' | F4:w',
       hands='right', goal=G_R7),
    Gx('r8-sight-1', 'R8 Sight-reading 1 (right hand)', 'R8', 'reading', 60,
       rh=_sight(801, UP5, 'C4:w'),
       hands='right', mode='live', goal=G_R8),
    Gx('r8-sight-2', 'R8 Sight-reading 2 (right hand)', 'R8', 'reading', 60,
       rh=_sight(802, UP5, 'C4:w'),
       hands='right', mode='live', goal=G_R8),
    Gx('r8-sight-3', 'R8 Sight-reading 3 (left hand)', 'R8', 'reading', 60,
       lh=_sight(803, LOW5, 'C3:w'),
       hands='left', mode='live', goal=G_R8),
    Gx('r8-sight-4', 'R8 Sight-reading 4 (G position, right hand)', 'R8', 'reading', 60,
       rh=_sight(804, ['G4', 'A4', 'B4', 'C5', 'D5'], 'G4:w'),
       hands='right', mode='live', goal=G_R8),
    Gx('r8-sight-5', 'R8 Sight-reading 5 (3/4, right hand)', 'R8', 'reading', 60, time='3/4',
       rh=_sight(805, UP5, 'C4:h.', rhythms=_RHYTHMS_34),
       hands='right', mode='live', goal=G_R8),
]
