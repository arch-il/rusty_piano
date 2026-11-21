import hashlib

import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach.library.genx import track_pieces

IDS = ['piece-first-steps', 'piece-evening-song', 'piece-ode-to-joy',
       'piece-twinkle', 'piece-lightly-row', 'piece-little-waltz',
       'piece-row-your-boat', 'piece-minuet-in-g', 'piece-little-lament',
       'piece-bells-at-dusk']
PLANNED_SKILL_IDS = set('''R1 R2 R3 R4 R14 R5 R11 R6 R7 R12 R13 R8 T1 T2 T3 T4 T10 T5 T8 T9 T6 T7 T11
K1 K2 K3 K8 K11 K4 K5 K6 K9 K10 C1 C2 C3 C4 C5 C6 D1 D2 D3 D4 P1 P2 M1 M2 M3 M4 M5
S1 S2 S3 S7 S9 S8 S10 S11 S4 S5 S6 E1 E2 E3 E4 E5 E6'''.split())
PINS = {'piece-evening-song': 'ce8b3e6b60163ccd', 'piece-first-steps': 'ab93b42d3f7207ae'}
EX = {e.key: e for e in track_pieces.EXERCISES}


@pytest.fixture(scope='module')
def loaded(tmp_path_factory):
    return check_exercises(track_pieces.EXERCISES, tmp_path_factory.mktemp('pieces'),
                           track='pieces', nodes=IDS, per_node=(1, 1))


def test_order():
    assert [e.key for e in track_pieces.EXERCISES] == IDS
    assert [p['id'] for p in track_pieces.PIECE_NODES] == IDS


def test_nodes():
    assert len(PLANNED_SKILL_IDS) == 67
    for p in track_pieces.PIECE_NODES:
        assert set(p) == {'id', 'title', 'summary', 'requires', 'measures'}
        assert p['title'] == EX[p['id']].title
        assert set(p['requires']) <= PLANNED_SKILL_IDS
    nodes = {p['id']: p for p in track_pieces.PIECE_NODES}
    assert nodes['piece-bells-at-dusk']['requires'] == ['P2', 'R7']


def test_meta():
    for e in track_pieces.EXERCISES:
        assert e.hands == 'both' and e.mode == 'live'
    assert EX['piece-ode-to-joy'].composer == 'Ludwig van Beethoven, arr. rusty_piano'
    assert EX['piece-twinkle'].composer == 'Traditional, arr. rusty_piano'
    assert EX['piece-lightly-row'].composer == 'Traditional, arr. rusty_piano'
    for k in ('piece-first-steps', 'piece-evening-song', 'piece-little-waltz'):
        assert EX[k].composer == 'rusty_piano'
    assert EX['piece-first-steps'].lh == '' and EX['piece-ode-to-joy'].lh == ''
    assert EX['piece-evening-song'].rh == ''
    for k in ('piece-twinkle', 'piece-lightly-row', 'piece-little-waltz'):
        assert EX[k].rh and EX[k].lh
    assert EX['piece-little-waltz'].time == '3/4'
    assert EX['piece-row-your-boat'].composer == 'Traditional, arr. rusty_piano'
    assert EX['piece-minuet-in-g'].composer == 'Christian Petzold, arr. rusty_piano'
    for k in ('piece-little-lament', 'piece-bells-at-dusk'):
        assert EX[k].composer == 'rusty_piano'
    assert EX['piece-row-your-boat'].time == '6/8'
    assert EX['piece-minuet-in-g'].time == '3/4'


def test_pins():
    for k, h in PINS.items():
        assert hashlib.sha256(EX[k].musicxml().encode()).hexdigest()[:16] == h


def test_note_counts(loaded):
    assert count_notes(loaded['piece-ode-to-joy'], 'right') == 30
    assert count_notes(loaded['piece-twinkle'], 'right') == 42
    assert count_notes(loaded['piece-twinkle'], 'left') == 22
    assert count_notes(loaded['piece-lightly-row'], 'right') == 49
    assert count_notes(loaded['piece-lightly-row'], 'left') == 30
    assert count_notes(loaded['piece-little-waltz'], 'right') == 16
    assert count_notes(loaded['piece-little-waltz'], 'left') == 36
    assert count_notes(loaded['piece-first-steps'], 'right') == 26
    assert count_notes(loaded['piece-first-steps'], 'left') == 0
    assert count_notes(loaded['piece-evening-song'], 'left') == 24
    assert count_notes(loaded['piece-evening-song'], 'right') == 0
    assert count_notes(loaded['piece-row-your-boat'], 'right') == 29
    assert count_notes(loaded['piece-row-your-boat'], 'left') == 27
    assert count_notes(loaded['piece-minuet-in-g'], 'right') == 64
    assert count_notes(loaded['piece-minuet-in-g'], 'left') == 26
    assert count_notes(loaded['piece-little-lament'], 'right') == 24
    assert count_notes(loaded['piece-little-lament'], 'left') == 15
    assert count_notes(loaded['piece-bells-at-dusk'], 'right') == 17
    assert count_notes(loaded['piece-bells-at-dusk'], 'left') == 29
