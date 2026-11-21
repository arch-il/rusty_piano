import hashlib

import pytest

from genx_check import check_exercises, count_notes
from rusty_piano_coach.library.genx import track_coordination

KEYS = [
    'c1-take-turns', 'c1-melody-rh', 'c1-melody-lh', 'c1-hand-off', 'c1-read-1',
    'c2-held-c', 'c2-held-c-g', 'c2-held-halves', 'c2-lh-tune', 'c2-held-g',
    'c3-octaves', 'c3-contrary', 'c3-tenths-halves', 'c3-tenths-quarters', 'c3-melody-bass',
    'c4-quarters-halves', 'c4-eighths-quarters', 'c4-halves-quarters', 'c4-dotted-tune', 'c4-lh-eighths',
    'c5-held-chords', 'c5-repeated-chords', 'c5-g-major', 'c5-broken-accomp',
    'c6-legato-over-staccato', 'c6-staccato-over-legato', 'c6-slurs-over-legato', 'c6-staccato-chords',
]

PINS = {
    'c1-take-turns': '9d5c8cf66bbf557c',
    'c1-melody-rh': '86610dc1eea6eba0',
    'c1-melody-lh': '3a5eb1ab9f654427',
    'c1-hand-off': 'dbebce14f864800f',
    'c1-read-1': '19623745d4316e07',
}


@pytest.fixture(scope='module')
def loaded(tmp_path_factory):
    return check_exercises(track_coordination.EXERCISES, tmp_path_factory.mktemp('coordination'),
                           track='coordination', nodes=['C1', 'C2', 'C3', 'C4', 'C5', 'C6'])


def by_key(k):
    return next(e for e in track_coordination.EXERCISES if e.key == k)


def test_house_rules(loaded):
    assert len(loaded) == 28


def test_counts_and_keys():
    for node, n in (('C1', 5), ('C2', 5), ('C3', 5), ('C4', 5), ('C5', 4), ('C6', 4)):
        assert sum(1 for e in track_coordination.EXERCISES if e.node == node) == n
    assert [e.key for e in track_coordination.EXERCISES] == KEYS


def test_hands():
    for e in track_coordination.EXERCISES:
        if e.key == 'c1-melody-rh':
            assert e.hands == 'right'
        elif e.key == 'c1-melody-lh':
            assert e.hands == 'left'
        else:
            assert e.hands == 'both'
        assert e.mode == ('wait' if e.node in ('C1', 'C2') else 'live'), e.key


@pytest.mark.parametrize('k', ['c1-take-turns', 'c1-hand-off', 'c1-read-1'])
def test_take_turns(k):
    e = by_key(k)
    pairs = list(zip(e.rh.split('|'), e.lh.split('|')))
    assert len(pairs) == len(e.rh.split('|')) == len(e.lh.split('|'))
    for rh_bar, lh_bar in pairs:
        assert 'r' in (rh_bar.strip(), lh_bar.strip())


def test_together(loaded):
    for k in KEYS:
        if k.startswith(('c2-', 'c3-', 'c4-', 'c5-', 'c6-')):
            assert count_notes(loaded[k], 'right') > 0, k
            assert count_notes(loaded[k], 'left') > 0, k


def test_no_waltz_bass():
    for e in track_coordination.EXERCISES:
        assert 'C3 E3+G3 E3+G3' not in e.lh, e.key


@pytest.mark.parametrize('k', list(PINS))
def test_c1_pins(k):
    assert hashlib.sha256(by_key(k).musicxml().encode('utf-8')).hexdigest()[:16] == PINS[k]
