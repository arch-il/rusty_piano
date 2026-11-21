from .core import Gx

G_M1 = 'Find the root, then a major third (4 half steps) and a fifth; for minor, lower the third by a half step.'
G_M2 = 'Same three notes, a different bottom note: keep the shape in your hand as you move.'
G_M3 = 'Move to the nearest chord notes; most fingers stay where they are.'
G_M4 = 'Read the chord symbol, then play it; the 3rd and 7th move by step.'
G_M5 = 'Twelve bars: four of C7, two of F7, two of C7, then G7, F7, C7, G7.'
G_M4_SEVENTHS = 'Read each chord symbol; C stays at the bottom and only the notes that change move, by a half step.'
G_M5_SCALE = 'C blues scale: C, E flat, F, F sharp, G, B flat, C; keep every note even up and down.'
G_M5_RIFF = 'Swing the riff long-short and play it the same way every time it comes back.'

BLUES_SYMBOLS = '1:C7 5:F7 7:C7 9:G7 10:F7 11:C7 12:G7'
BLUES_LH = ' | '.join(['C3+E3+Bb3:w'] * 4 + ['F2+A2+Eb3:w'] * 2 + ['C3+E3+Bb3:w'] * 2
                      + ['G2+B2+F3:w', 'F2+A2+Eb3:w', 'C3+E3+Bb3:w', 'G2+B2+F3:w'])


def _m(key, title, node, bpm, mode, goal, hands, symbols, fifths=0, rh='', lh=''):
    return Gx(key, title, node, 'harmony', bpm, rh=rh, lh=lh, hands=hands, mode=mode, goal=goal,
              fifths=fifths, symbols=symbols)


EXERCISES = [
    _m('m1-white-majors', 'M1 C, F and G major triads (right hand)', 'M1', 60, 'wait', G_M1, 'right',
       '1:C 1.3:F 2:G 2.3:C 3:F 3.3:G 4:C',
       rh='C4+E4+G4:h F4+A4+C5:h | G4+B4+D5:h C4+E4+G4:h | F4+A4+C5:h G4+B4+D5:h | C4+E4+G4:w'),
    _m('m1-black-middle', 'M1 D, E and A major: black key in the middle (right hand)', 'M1', 60, 'wait', G_M1, 'right',
       '1:D 1.3:E 2:A 2.3:D 3:E 3.3:A 4:D',
       rh='D4+F#4+A4:h E4+G#4+B4:h | A4+C#5+E5:h D4+F#4+A4:h | E4+G#4+B4:h A4+C#5+E5:h | D4+F#4+A4:w'),
    _m('m1-minors', 'M1 Major to minor: lower the third (right hand)', 'M1', 60, 'wait', G_M1, 'right',
       '1:C 1.3:Cm 2:D 2.3:Dm 3:E 3.3:Em 4:A 4.3:Am',
       rh='C4+E4+G4:h C4+Eb4+G4:h | D4+F#4+A4:h D4+F4+A4:h | E4+G#4+B4:h E4+G4+B4:h | A4+C#5+E5:h A4+C5+E5:h'),
    _m('m1-black-roots', 'M1 Triads on black-key roots (right hand)', 'M1', 60, 'wait', G_M1, 'right',
       '1:Db 1.3:Eb 2:Gb 2.3:Ab 3:Bb 3.3:B 4:C',
       rh='Db4+F4+Ab4:h Eb4+G4+Bb4:h | Gb4+Bb4+Db5:h Ab4+C5+Eb5:h | Bb3+D4+F4:h B3+D#4+F#4:h | C4+E4+G4:w'),
    _m('m1-circle-lh', 'M1 All twelve major triads round the circle of fifths (left hand)', 'M1', 60, 'wait', G_M1, 'left',
       '1:C 1.3:G 2:D 2.3:A 3:E 3.3:B 4:F# 4.3:Db 5:Ab 5.3:Eb 6:Bb 6.3:F 7:C',
       lh='C3+E3+G3:h G2+B2+D3:h | D3+F#3+A3:h A2+C#3+E3:h | E3+G#3+B3:h B2+D#3+F#3:h | F#3+A#3+C#4:h Db3+F3+Ab3:h'
          ' | Ab2+C3+Eb3:h Eb3+G3+Bb3:h | Bb2+D3+F3:h F2+A2+C3:h | C3+E3+G3:w'),
    _m('m2-c-inversions-rh', 'M2 C major inversions (right hand)', 'M2', 60, 'live', G_M2, 'right',
       '1:C 1.3:C/E 2:C/G 2.3:C 3:C/G 3.3:C/E 4:C',
       rh='C4+E4+G4:h E4+G4+C5:h | G4+C5+E5:h C5+E5+G5:h | G4+C5+E5:h E4+G4+C5:h | C4+E4+G4:w'),
    _m('m2-f-g-inversions-rh', 'M2 F and G major inversions (right hand)', 'M2', 60, 'live', G_M2, 'right',
       '1:F 1.3:F/A 2:F/C 2.3:F/A 3:G 3.3:G/B 4:G/D 4.3:G',
       rh='F4+A4+C5:h A4+C5+F5:h | C5+F5+A5:h A4+C5+F5:h | G4+B4+D5:h B4+D5+G5:h | D5+G5+B5:h G4+B4+D5:h'),
    _m('m2-inversions-lh', 'M2 Inversions (left hand)', 'M2', 60, 'live', G_M2, 'left',
       '1:C 1.3:C/E 2:C/G 2.3:C 3:F 3.3:F/A 4:F/C 4.3:F 5:C',
       lh='C3+E3+G3:h E3+G3+C4:h | G2+C3+E3:h C3+E3+G3:h | F2+A2+C3:h A2+C3+F3:h | C3+F3+A3:h F2+A2+C3:h | C3+E3+G3:w'),
    _m('m2-minor-inversions', 'M2 Minor chord inversions (right hand)', 'M2', 60, 'live', G_M2, 'right',
       '1:Am 1.3:Am/C 2:Am/E 2.3:Am/C 3:Dm 3.3:Dm/F 4:Em 4.3:Em/G 5:Am',
       rh='A3+C4+E4:h C4+E4+A4:h | E4+A4+C5:h C4+E4+A4:h | D4+F4+A4:h F4+A4+D5:h | E4+G4+B4:h G4+B4+E5:h | A3+C4+E4:w'),
    _m('m3-g-major-lh', 'M3 I-IV-V7 in G major (left hand)', 'M3', 60, 'live', G_M3, 'left',
       '1:G 1.3:C/G 2:D7/F# 2.3:G 3:C/G 3.3:G 4:D7/F# 4.3:G', fifths=1,
       lh='G2+B2+D3:h G2+C3+E3:h | F#2+C3+D3:h G2+B2+D3:h | G2+C3+E3:h G2+B2+D3:h | F#2+C3+D3:h G2+B2+D3:h'),
    _m('m3-f-major-lh', 'M3 I-IV-V7 in F major (left hand)', 'M3', 60, 'live', G_M3, 'left',
       '1:F 1.3:Bb/F 2:C7/E 2.3:F 3:Bb/F 3.3:F 4:C7/E 4.3:F', fifths=-1,
       lh='F2+A2+C3:h F2+Bb2+D3:h | E2+Bb2+C3:h F2+A2+C3:h | F2+Bb2+D3:h F2+A2+C3:h | E2+Bb2+C3:h F2+A2+C3:h'),
    _m('m3-a-minor-lh', 'M3 i-iv-V7 in A minor (left hand)', 'M3', 60, 'live', G_M3, 'left',
       '1:Am 1.3:Dm/A 2:E7/G# 2.3:Am 3:Dm/A 3.3:Am 4:E7/G# 4.3:Am', fifths=0,
       lh='A2+C3+E3:h A2+D3+F3:h | G#2+D3+E3:h A2+C3+E3:h | A2+D3+F3:h A2+C3+E3:h | G#2+D3+E3:h A2+C3+E3:h'),
    _m('m3-cadence-rh', 'M3 I-IV-V7-I in G (right hand)', 'M3', 60, 'live', G_M3, 'right',
       '1:G 1.3:C 2:D7 2.3:G 3:G 3.2:C 3.3:D7 3.4:G 4:G', fifths=1,
       rh='B3+D4+G4:h C4+E4+G4:h | C4+D4+F#4:h B3+D4+G4:h | B3+D4+G4 C4+E4+G4 C4+D4+F#4 B3+D4+G4 | B3+D4+G4:w'),
    _m('m4-sevenths-c', 'M4 Seventh chords on C (right hand)', 'M4', 60, 'live', G_M4_SEVENTHS, 'right',
       '1:Cmaj7 2:C7 3:Cm7 4:Cm7b5 5:Cmaj7',
       rh='C4+E4+G4+B4:w | C4+E4+G4+Bb4:w | C4+Eb4+G4+Bb4:w | C4+Eb4+Gb4+Bb4:w | C4+E4+G4+B4:w'),
    _m('m4-shells-c', 'M4 ii-V-I shells in C (left hand)', 'M4', 60, 'live', G_M4, 'left',
       '1:Dm7 2:G7 3:Cmaj7 4:Cmaj7',
       lh='D3+F3+C4:w | G2+F3+B3:w | C3+E3+B3:w | C3+E3+B3:w'),
    _m('m4-ii-v-i-f', 'M4 ii-V-I in F: guide tones over roots', 'M4', 60, 'live', G_M4, 'both',
       '1:Gm7 2:C7 3:Fmaj7 4:Fmaj7', fifths=-1,
       rh='F4+Bb4:w | E4+Bb4:w | E4+A4:w | E4+A4:w', lh='G2:w | C3:w | F2:w | F2:w'),
    _m('m4-ii-v-i-bb', 'M4 ii-V-I in B flat: guide tones over roots', 'M4', 60, 'live', G_M4, 'both',
       '1:Cm7 2:F7 3:Bbmaj7 4:Bbmaj7', fifths=-2,
       rh='Eb4+Bb4:w | Eb4+A4:w | D4+A4:w | D4+A4:w', lh='C3:w | F2:w | Bb2:w | Bb2:w'),
    _m('m5-blues-lh', 'M5 Twelve-bar blues shells (left hand)', 'M5', 72, 'live', G_M5, 'left', BLUES_SYMBOLS,
       lh=BLUES_LH),
    _m('m5-blues-scale-rh', 'M5 C blues scale (right hand)', 'M5', 72, 'live', G_M5_SCALE, 'right', '1:C7',
       rh='C4 Eb4 F4 F#4 | G4 Bb4 C5:h | C5 Bb4 G4 F#4 | F4 Eb4 C4:h'),
    _m('m5-riff-rh', 'M5 Blues riff in swing (right hand)', 'M5', 72, 'live', G_M5_RIFF, 'right', '1:C7',
       rh='C5:3e~ C5:3e Bb4:3e G4:3e~ G4:3e Eb4:3e F4:3e~ F4:3e F#4:3e G4'
          ' | C5:3e~ C5:3e Bb4:3e G4:3e~ G4:3e Eb4:3e C4:h'
          ' | C5:3e~ C5:3e Bb4:3e G4:3e~ G4:3e Eb4:3e F4:3e~ F4:3e F#4:3e G4'
          ' | G4:3e~ G4:3e F#4:3e F4:3e~ F4:3e Eb4:3e C4:h'),
    _m('m5-blues-melody', 'M5 Twelve-bar blues melody', 'M5', 72, 'live', G_M5, 'both', BLUES_SYMBOLS,
       rh='G4 Bb4 G4 Eb4 | C4:h r:h | G4 Bb4 C5 Bb4 | G4:w | C5 Bb4 G4 F4 | Eb4:h C4:h | G4 Bb4 G4 Eb4 | C4:w'
          ' | D5 C5 Bb4 G4 | C5 Bb4 G4 F4 | Eb4 E4 G4 C5 | D5 B4 G4 F4',
       lh='C3:w | C3:w | C3:w | C3:w | F2:w | F2:w | C3:w | C3:w | G2:w | F2:w | C3:w | G2:w'),
]
