from .core import Gx

G_PIECE = 'Play the whole piece through in time; keep going if you slip.'

EXERCISES = [
    Gx('piece-first-steps', 'First Steps', 'piece-first-steps', 'pieces', 72,
       rh='C4 D4 E4 C4 | E4 F4 G4:h | G4 F4 E4 D4 | E4:h C4:h | C4 D4 E4 F4 | G4 E4 F4 D4 | E4 D4 C4 D4 | C4:w',
       hands='both', mode='live', goal=G_PIECE, composer='rusty_piano'),
    Gx('piece-evening-song', 'Evening Song', 'piece-evening-song', 'pieces', 72,
       lh='C3 D3 E3 C3 | E3 F3 G3:h | G3 F3 E3 D3 | C3:w | G3 E3 F3 D3 | E3 C3 D3:h | E3 D3 C3 D3 | C3:w',
       hands='both', mode='live', goal=G_PIECE, composer='rusty_piano'),
    Gx('piece-ode-to-joy', 'Ode to Joy', 'piece-ode-to-joy', 'pieces', 80,
       rh='E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4 D4 D4:h | E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4 C4 C4:h',
       hands='both', mode='live', goal=G_PIECE, composer='Ludwig van Beethoven, arr. rusty_piano'),
    Gx('piece-twinkle', 'Twinkle, Twinkle, Little Star', 'piece-twinkle', 'pieces', 80,
       rh='C4 C4 G4 G4 | A4 A4 G4:h | F4 F4 E4 E4 | D4 D4 C4:h | G4 G4 F4 F4 | E4 E4 D4:h | G4 G4 F4 F4 | E4 E4 D4:h | C4 C4 G4 G4 | A4 A4 G4:h | F4 F4 E4 E4 | D4 D4 C4:h',
       lh='C3:w | F3:h E3:h | D3:h C3:h | G3:h C3:h | E3:h D3:h | C3:h G3:h | E3:h D3:h | C3:h G3:h | C3:w | F3:h E3:h | D3:h C3:h | G3:h C3:h',
       hands='both', mode='live', goal=G_PIECE, composer='Traditional, arr. rusty_piano'),
    Gx('piece-lightly-row', 'Lightly Row', 'piece-lightly-row', 'pieces', 88,
       rh='G4 E4 E4:h | F4 D4 D4:h | C4 D4 E4 F4 | G4 G4 G4:h | G4 E4 E4:h | F4 D4 D4:h | C4 E4 G4 G4 | C4:w | D4 D4 D4 D4 | D4 E4 F4:h | E4 E4 E4 E4 | E4 F4 G4:h | G4 E4 E4:h | F4 D4 D4:h | C4 E4 G4 G4 | C4:w',
       lh='C3:h G3:h | G3:h F3:h | C3:h G3:h | E3:h C3:h | C3:h G3:h | G3:h F3:h | C3:h E3:h | C3:w | G3:h F3:h | G3:h D3:h | C3:h G3:h | C3:h E3:h | C3:h G3:h | G3:h F3:h | C3:h E3:h | C3:w',
       hands='both', mode='live', goal=G_PIECE, composer='Traditional, arr. rusty_piano'),
    Gx('piece-little-waltz', 'Little Waltz', 'piece-little-waltz', 'pieces', 96,
       time='3/4',
       rh='mf G4:h E4 | F4:h D4 | E4 C4 E4 | G4:h. | p G4:h E4 | F4:h D4 | cresc E4 F4 D4 | end mf C4:h.',
       lh='C3 E3+G3 E3+G3 | B2 D3+G3 D3+G3 | C3 E3+G3 E3+G3 | C3 E3+G3 E3+G3 | C3 E3+G3 E3+G3 | B2 D3+G3 D3+G3 | B2 D3+G3 D3+G3 | C3:h.',
       hands='both', mode='live', goal=G_PIECE, composer='rusty_piano'),
]

PIECE_NODES = [
    {'id': 'piece-first-steps', 'title': 'First Steps', 'summary': 'A first tune for the right hand in C position.', 'requires': ['R2', 'T2'], 'measures': ['pitch', 'timing']},
    {'id': 'piece-evening-song', 'title': 'Evening Song', 'summary': 'A calm tune for the left hand in C position.', 'requires': ['R3', 'T2'], 'measures': ['pitch', 'timing']},
    {'id': 'piece-ode-to-joy', 'title': 'Ode to Joy', 'summary': 'Beethoven\'s melody for the right hand in C position.', 'requires': ['R2', 'T2', 'C1'], 'measures': ['pitch', 'timing']},
    {'id': 'piece-twinkle', 'title': 'Twinkle, Twinkle, Little Star', 'summary': 'The tune in the right hand over slow left-hand notes.', 'requires': ['R4', 'C2'], 'measures': ['pitch', 'timing']},
    {'id': 'piece-lightly-row', 'title': 'Lightly Row', 'summary': 'Hands together with a half-note left hand.', 'requires': ['R4', 'C4'], 'measures': ['pitch', 'timing']},
    {'id': 'piece-little-waltz', 'title': 'Little Waltz', 'summary': 'A waltz with a bass-chord-chord left hand and dynamics.', 'requires': ['C4', 'K6', 'D1'], 'measures': ['pitch', 'timing', 'velocity']},
]
