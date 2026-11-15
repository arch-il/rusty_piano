import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach import plan
from rusty_piano_coach.library.genx import track_pieces

IDS = ['piece-first-steps', 'piece-evening-song', 'piece-ode-to-joy',
       'piece-twinkle', 'piece-lightly-row', 'piece-little-waltz']
EX = {e.key: e for e in track_pieces.EXERCISES}


@pytest.fixture(scope='module')
def loaded(tmp_path_factory):
    return check_exercises(track_pieces.EXERCISES, tmp_path_factory.mktemp('pieces'),
                           track='pieces', nodes=IDS, per_node=(1, 1))


def test_order():
    assert [e.key for e in track_pieces.EXERCISES] == IDS
    assert [p['id'] for p in track_pieces.PIECE_NODES] == IDS


def test_nodes():
    skill_ids = {n['id'] for n in plan.load_json(plan.SEED_TREE)['nodes'] if not n['id'].startswith('piece-')}
    for p in track_pieces.PIECE_NODES:
        assert set(p) == {'id', 'title', 'summary', 'requires', 'measures'}
        assert p['title'] == EX[p['id']].title
        assert set(p['requires']) <= skill_ids


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
