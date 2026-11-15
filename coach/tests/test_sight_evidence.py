import json
from datetime import date, datetime, timezone

from evidence_fixtures import make_attempt, tiny_tree, write_attempts
from test_sight import sight_attempt, sight_step

from rusty_piano_coach import sight, trends

UTC = timezone.utc


def build(tmp_path, attempt_list):
    ad, rd, pd, sd = (tmp_path / n for n in ("attempts", "reports", "plan", "scores"))
    pd.mkdir()
    (pd / "tree.json").write_text(json.dumps(tiny_tree()), encoding="utf-8")
    write_attempts(ad, attempt_list)
    return trends.build_evidence(
        attempts_dir=ad,
        reports_dir=rd,
        plan_dir=pd,
        scores_dir=sd,
        since=None,
        today=date(2026, 11, 7),
        tz=UTC,
        now=datetime(2026, 11, 7, 12, tzinfo=UTC),
    )


def round_attempt(n, reactions, first_try=None):
    first_try = first_try or [True] * len(reactions)
    return sight_attempt(
        id=f"attempt-20261106-2000{n:02d}-aaaaa{n}",
        started_at=f"2026-11-06T20:{n:02d}:00.000Z",
        steps=[sight_step(i, ms, first_try=ft) for i, (ms, ft) in enumerate(zip(reactions, first_try))],
    )


def test_sight_block_for_three_rounds(tmp_path):
    atts = [
        round_attempt(1, [1000, 1100, 1200]),
        round_attempt(2, [900, 1500, 1300], first_try=[False, True, True]),
        round_attempt(3, [800, 800, 800]),
    ]
    ev = build(tmp_path, atts)
    assert ev["drills"]["sr.r2-treble"]["sight"] == {
        "rounds": 3,
        "cards": 9,
        "mean_accuracy": 0.889,
        "best_accuracy": 1.0,
        "recent_accuracy": 0.889,
        "mean_ms": 1066.7,
        "target_ms": {"good": 2000, "solid": 1200, "mastered": 800},
    }
    assert "ear" not in ev["drills"]["sr.r2-treble"]


def test_sight_recent_window_is_last_five_rounds(tmp_path):
    atts = [round_attempt(1, [1000, 1000, 1000], first_try=[False] * 3)]
    atts += [round_attempt(n, [1000, 1000, 1000]) for n in range(2, 7)]
    ev = build(tmp_path, atts)
    sight_entry = ev["drills"]["sr.r2-treble"]["sight"]
    assert sight_entry["rounds"] == 6
    assert sight_entry["mean_accuracy"] == 0.833
    assert sight_entry["best_accuracy"] == 1.0
    assert sight_entry["recent_accuracy"] == 1.0


def test_pending_step_not_counted_in_cards(tmp_path):
    pending = sight_step(2, 900, first_try=True)
    pending["result"] = "pending"
    atts = [round_attempt(1, [1000, 1000]), round_attempt(2, [1000, 1000])]
    atts[1]["steps"].append(pending)
    ev = build(tmp_path, atts)
    assert ev["drills"]["sr.r2-treble"]["sight"]["cards"] == 4


def test_normal_drill_has_no_sight_key(tmp_path):
    other = make_attempt(id="attempt-20261101-100000-bbbbb1", drill_id="t1.q")
    ev = build(tmp_path, [other, round_attempt(1, [1000, 1000])])
    assert "sight" not in ev["drills"]["t1.q"]
    assert "ear" not in ev["drills"]["sr.r2-treble"]
    assert "sight" in ev["drills"]["sr.r2-treble"]


def test_drill_stats_empty():
    assert sight.drill_stats([]) == {
        "rounds": 0,
        "cards": 0,
        "mean_accuracy": None,
        "best_accuracy": None,
        "recent_accuracy": None,
        "mean_ms": None,
        "target_ms": {"good": 2000, "solid": 1200, "mastered": 800},
    }
