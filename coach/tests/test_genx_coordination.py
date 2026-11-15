import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach.library.genx import track_coordination

KEYS = [
    'c1-take-turns', 'c1-melody-rh', 'c1-melody-lh', 'c1-hand-off', 'c1-read-1',
    'c2-held-c', 'c2-held-c-g', 'c2-held-halves', 'c2-lh-tune', 'c2-waltz',
    'c3-octaves', 'c3-contrary', 'c3-tenths-halves', 'c3-tenths-quarters', 'c3-melody-bass',
    'c4-quarters-halves', 'c4-eighths-quarters', 'c4-halves-quarters', 'c4-dotted-tune', 'c4-waltz',
]


@pytest.fixture(scope='module')
def loaded(tmp_path_factory):
    return check_exercises(track_coordination.EXERCISES, tmp_path_factory.mktemp('coordination'),
                           track='coordination', nodes=['C1', 'C2', 'C3', 'C4'])


def by_key(k):
    return next(e for e in track_coordination.EXERCISES if e.key == k)


def test_house_rules(loaded):
    assert len(loaded) == 20


def test_counts_and_keys():
    for node in ('C1', 'C2', 'C3', 'C4'):
        assert sum(1 for e in track_coordination.EXERCISES if e.node == node) == 5
    assert [e.key for e in track_coordination.EXERCISES] == KEYS


def test_hands():
    for e in track_coordination.EXERCISES:
        if e.key == 'c1-melody-rh':
            assert e.hands == 'right'
        elif e.key == 'c1-melody-lh':
            assert e.hands == 'left'
        else:
            assert e.hands == 'both'
        assert e.mode == 'wait'


@pytest.mark.parametrize('k', ['c1-take-turns', 'c1-hand-off', 'c1-read-1'])
def test_take_turns(k):
    e = by_key(k)
    pairs = list(zip(e.rh.split('|'), e.lh.split('|')))
    assert len(pairs) == len(e.rh.split('|')) == len(e.lh.split('|'))
    for rh_bar, lh_bar in pairs:
        assert 'r' in (rh_bar.strip(), lh_bar.strip())


def test_together(loaded):
    for k in KEYS:
        if k.startswith(('c2-', 'c3-', 'c4-')):
            assert count_notes(loaded[k], 'right') > 0, k
            assert count_notes(loaded[k], 'left') > 0, k


def test_waltzes():
    assert by_key('c2-waltz').time == '3/4'
    assert by_key('c4-waltz').time == '3/4'
