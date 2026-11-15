import json
from datetime import date, datetime, timezone

import pytest
from evidence_fixtures import (
    make_attempt,
    make_report,
    make_steps,
    note_on,
    scored_steps,
    tiny_tree,
    wait_steps,
    write_attempts,
    write_reports,
)

from rusty_piano_coach import attempts, plan, runs, trends
from rusty_piano_coach.cli import main

UTC = timezone.utc
GATE = tiny_tree()["default_gates"]["good"]
LIVE_DRILL = tiny_tree()["nodes"][0]["drills"][0]
WAIT_DRILL = tiny_tree()["nodes"][2]["drills"][0]
NOW = datetime(2026, 11, 5, 12, 0, tzinfo=UTC)


def one_run(**kw):
    return runs.runs_of_attempt(make_attempt(**kw), UTC)[0]


def aid(n):
    return f"attempt-2026110{n}-100000-aaaaa{n}"


def setup_dirs(tmp_path, attempt_list=(), report_list=(), state=None):
    ad, rd, pd, sd = (tmp_path / n for n in ("attempts", "reports", "plan", "scores"))
    pd.mkdir()
    (pd / "tree.json").write_text(json.dumps(tiny_tree()), encoding="utf-8")
    if state is not None:
        (pd / "state.json").write_text(json.dumps(state), encoding="utf-8")
    write_attempts(ad, attempt_list)
    write_reports(rd, report_list)
    return ad, rd, pd, sd


def build(tmp_path, attempt_list=(), report_list=(), since=None, **kw):
    ad, rd, pd, sd = setup_dirs(tmp_path, attempt_list, report_list)
    return trends.build_evidence(
        attempts_dir=ad,
        reports_dir=rd,
        plan_dir=pd,
        scores_dir=sd,
        since=since,
        today=date(2026, 11, 5),
        tz=UTC,
        now=NOW,
        **kw,
    )


def test_tiny_tree_is_valid():
    assert plan.validate_tree(tiny_tree()) == []


def test_fixture_attempts_validate():
    attempts.validate_attempt(make_attempt())
    attempts.validate_attempt(make_attempt(steps=wait_steps(4), mode="wait"))


def test_timing_ok():
    s = make_steps(["hit", "early", "late", "missed"])
    assert [runs.timing_ok(x) for x in s] == [True, False, False, None]
    assert runs.timing_ok(wait_steps(1)[0]) is None


def test_accuracy_and_run_timing():
    r = one_run(steps=make_steps(["hit", "early", "wrong", "missed", "pending"]))
    assert runs.run_accuracy(r) == 0.5
    assert runs.run_accuracy(one_run(steps=[])) is None


def test_step_timing():
    assert runs.step_timing(scored_steps([75])[0]) == 0.75
    old = make_steps(["hit"], offsets=[20])[0]
    assert "timing_score" not in old
    assert runs.step_timing(old) == 1.0
    assert runs.step_timing(make_steps(["missed"])[0]) is None


def test_run_timing():
    assert runs.run_timing(one_run(steps=scored_steps([100, 50]))) == 0.75
    assert runs.run_timing(one_run(steps=wait_steps(4), mode="wait")) is None
    assert runs.run_timing(one_run(steps=make_steps(["missed", "missed"]))) is None


def test_clean_run_reads_graded_timing():
    late = scored_steps([70] * 16, outcome="late", offset=90.0)
    r = one_run(steps=late)
    assert runs.is_clean(r, {**GATE, "timing": 0.6}, LIVE_DRILL)
    assert not runs.is_clean(r, {**GATE, "timing": 0.8}, LIVE_DRILL)


def test_drill_stats_include_timing_score(tmp_path):
    a = make_attempt(id=aid(1), drill_id="t1.q", steps=scored_steps([100, 50] * 8))
    ev = build(tmp_path, [a])
    assert ev["drills"]["t1.q"]["timing_score"] == 75


@pytest.mark.parametrize(
    "kw, expected",
    [
        ({}, True),
        ({"end": "stop"}, False),
        ({"steps": make_steps(["hit"] * 9 + ["wrong"])}, False),
        ({"steps": make_steps(["hit"] * 8 + ["early"] * 8, offsets=[0.0] * 8 + [-250.0] * 8)}, False),
        ({"steps": make_steps(["hit"] * 15 + ["short"])}, False),
        ({"hands": "both"}, False),
        ({"range": {"from": 1, "to": 2}}, False),
        ({"tempo_percent": 70}, False),
        ({"tags": ["fun"]}, False),
        ({"autoplay_used": True}, False),
    ],
)
def test_is_clean_live_drill(kw, expected):
    assert runs.is_clean(one_run(**kw), GATE, LIVE_DRILL) is expected


def test_wait_drill_ignores_tempo():
    r = one_run(mode="wait", hands="both", steps=wait_steps(16), tempo_percent=30)
    assert runs.is_clean(r, GATE, WAIT_DRILL)


def test_piece_clean_needs_live_both_whole_tempo():
    assert runs.is_clean(one_run(hands="both"), GATE, piece=True)
    assert not runs.is_clean(one_run(hands="both", tempo_percent=70), GATE, piece=True)
    assert not runs.is_clean(one_run(hands="right"), GATE, piece=True)


def test_loop_cycles_become_runs():
    steps = make_steps(["hit"] * 4, cycle=1) + make_steps(["hit"] * 4, cycle=2) + make_steps(["hit"] * 2, cycle=3)
    got = runs.runs_of_attempt(make_attempt(loop=True, steps=steps, steps_total=4, end="stop"), UTC)
    assert [r.cycle for r in got] == [1, 2]
    assert all(r.complete for r in got)
    partial = make_steps(["hit"] * 2, cycle=1)
    got = runs.runs_of_attempt(make_attempt(loop=True, steps=partial, steps_total=4, end="stop"), UTC)
    assert len(got) == 1 and got[0].cycle is None and not got[0].complete


def test_v1_attempt_loads_with_no_drill(tmp_path):
    v1 = make_attempt()
    v1["version"] = 1
    for k in ("drill_id", "plan_id", "tags"):
        del v1[k]
    write_attempts(tmp_path / "a", [v1])
    loaded, skipped = runs.load_attempts(tmp_path / "a")
    assert skipped == []
    assert runs.load_runs(loaded, UTC)[0].drill_id is None


def test_load_attempts_skips_incomplete(tmp_path):
    bad = make_attempt()
    del bad["practice"]
    write_attempts(tmp_path / "a", [bad])
    loaded, skipped = runs.load_attempts(tmp_path / "a")
    assert loaded == [] and "not a complete attempt" in skipped[0]


def test_pending_analysis(tmp_path):
    a1 = make_attempt(id=aid(1))
    a2 = make_attempt(id=aid(2), started_at="2026-11-02T10:00:00+00:00")
    ev = build(tmp_path, [a1, a2], [make_report(attempt_id=aid(1))])
    assert ev["pending_analysis"] == [aid(2)]


def test_fun_and_autoplay_are_excluded(tmp_path):
    good = make_attempt(id=aid(1), drill_id="t1.q", plan_id="p1")
    fun = make_attempt(id=aid(2), drill_id="t1.q", plan_id="p1", tags=["fun"])
    auto = make_attempt(id=aid(3), drill_id="t1.q", plan_id="p1", autoplay_used=True)
    ev = build(tmp_path, [good, fun, auto])
    assert ev["inputs"]["runs"] == 3
    assert ev["inputs"]["counted_runs"] == 1
    assert ev["inputs"]["fun_runs"] == 1
    assert ev["inputs"]["autoplay_runs"] == 1
    assert ev["drills"]["t1.q"]["runs"] == 1
    assert ev["drills"]["t1.q"]["node"] == "T1"
    assert ev["drills"]["t1.q"]["clean_good"] == 1
    assert ev["plans"]["p1"]["runs"] == 1
    assert ev["pending_analysis"] == [aid(1)]


def test_since_filters_window(tmp_path):
    old = make_attempt(id=aid(1))
    new = make_attempt(id=aid(3), started_at="2026-11-03T10:00:00+00:00")
    ev = build(tmp_path, [old, new], since=datetime(2026, 11, 2, tzinfo=UTC))
    assert ev["inputs"]["runs"] == 1
    assert ev["pending_analysis"] == [aid(3)]
    assert ev["since"].startswith("2026-11-02")


def test_habit_window_reaches_further_back(tmp_path, monkeypatch):
    seen = {}

    def detect(run_list, attempt_list, report_list, tree, state, score_keys):
        seen["runs"] = run_list
        seen["attempts"] = attempt_list
        return []

    monkeypatch.setattr(trends.habits, "detect", detect)
    early = make_attempt(id=aid(1), drill_id="t1.q", started_at="2026-10-29T10:00:00+00:00")
    late = make_attempt(id=aid(2), drill_id="t1.q", started_at="2026-11-03T10:00:00+00:00")
    ev = build(tmp_path, [early, late], since=datetime(2026, 11, 3, tzinfo=UTC))
    assert {r.attempt_id for r in seen["runs"]} == {aid(1), aid(2)}
    assert {a["id"] for a in seen["attempts"]} == {aid(1), aid(2)}
    assert ev["drills"]["t1.q"]["runs"] == 1


def test_bar_stats_and_hard_bars():
    results = ["hit"] * 4 + ["wrong", "missed", "hit", "hit"]
    rs = [one_run(id=aid(i), steps=make_steps(results)) for i in (1, 2, 3)]
    stats = runs.bar_stats(rs)
    assert stats[1]["errors"] == 0 and stats[1]["mean_offset_ms"] == 0.0
    assert stats[2]["runs"] == 3 and stats[2]["steps"] == 12
    assert stats[2]["wrong"] == 3 and stats[2]["missed"] == 3
    assert stats[2]["error_rate"] == 0.5
    assert runs.hard_bars(stats) == [2]
    assert runs.hard_bars(runs.bar_stats(rs[:2])) == []


def test_percentile():
    assert runs.percentile([], 0.5) is None
    assert runs.percentile(list(range(11)), 0.9) == 9


def test_features(tmp_path):
    steps = make_steps(["hit", "early", "late", "short", "missed", "hit"])
    events = [note_on(v) for v in range(40, 100, 5)]
    ev = build(tmp_path, [make_attempt(steps=steps, events=events)])
    f = ev["features"]
    assert f["timing"]["steps"] == 5
    assert f["timing"]["on_time_share"] == 0.6
    assert f["timing"]["early_share"] == 0.2
    assert f["timing"]["late_share"] == 0.2
    assert f["holds"] == {"checked": 1, "short": 1, "short_share": 1.0}
    assert f["velocity"]["notes"] == 12
    assert f["velocity"]["spread"] == f["velocity"]["p90"] - f["velocity"]["p10"]
    assert ev["pieces"]["gen:t1-quarters-rh"]["minutes"] == 1.0


def test_piece_bars_count_rushed_and_dragged(tmp_path):
    rows = [{"bar": 1, "tempo": "rushed"}, {"bar": 2, "tempo": "dragged"}]
    ev = build(tmp_path, [make_attempt(id=aid(1))], [make_report(attempt_id=aid(1), bars=rows)])
    bars = ev["pieces"]["gen:t1-quarters-rh"]["bars"]
    assert bars["1"]["rushed"] == 1 and bars["2"]["dragged"] == 1


def cli_args(tmp_path, *extra):
    return [
        "evidence",
        "--attempts-dir", str(tmp_path / "attempts"),
        "--reports-dir", str(tmp_path / "reports"),
        "--plan-dir", str(tmp_path / "plan"),
        "--data-dir", str(tmp_path / "scores"),
        "--today", "2026-11-05",
        "--utc",
        *extra,
    ]


def test_cli_json(tmp_path, capsys):
    setup_dirs(tmp_path, [make_attempt()])
    assert main(cli_args(tmp_path, "--json")) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["kind"] == "rusty_piano.evidence"
    assert isinstance(out["nodes"], dict)
    assert isinstance(out["habits"], list)


def test_json_bad_today_goes_to_stderr(tmp_path, capsys):
    setup_dirs(tmp_path, [make_attempt()])
    assert main(cli_args(tmp_path, "--json", "--today", "bad")) != 0
    cap = capsys.readouterr()
    assert cap.out == ""
    assert "error" in cap.err


def test_cli_text(tmp_path, capsys):
    setup_dirs(tmp_path, [make_attempt()])
    assert main(cli_args(tmp_path)) == 0
    out = capsys.readouterr().out
    assert "Runs:" in out and "Habit candidates" in out


def test_update_state_needs_state_json(tmp_path, capsys):
    setup_dirs(tmp_path, [make_attempt()])
    assert main(cli_args(tmp_path, "--update-state")) == 1
    assert "no state.json" in capsys.readouterr().out


def test_update_state_writes_file(tmp_path, capsys):
    state = {
        "version": 1,
        "kind": "rusty_piano.state",
        "updated_at": "2020-01-01T00:00:00Z",
        "last_review": None,
        "plan_id": None,
        "nodes": {},
        "habits": [],
    }
    setup_dirs(tmp_path, [make_attempt()], state=state)
    assert main(cli_args(tmp_path, "--update-state")) == 0
    written = json.loads((tmp_path / "plan" / "state.json").read_text(encoding="utf-8"))
    assert written["updated_at"] != "2020-01-01T00:00:00Z"


def test_json_update_state_keeps_stdout_pure(tmp_path, capsys):
    state = {
        "version": 1,
        "kind": "rusty_piano.state",
        "updated_at": "2020-01-01T00:00:00Z",
        "last_review": None,
        "plan_id": None,
        "nodes": {},
        "habits": [],
    }
    setup_dirs(tmp_path, [make_attempt()], state=state)
    assert main(cli_args(tmp_path, "--json", "--update-state")) == 0
    cap = capsys.readouterr()
    assert json.loads(cap.out)["kind"] == "rusty_piano.evidence"
    assert "Updated" in cap.err


def test_json_update_state_without_state_json(tmp_path, capsys):
    setup_dirs(tmp_path, [make_attempt()])
    assert main(cli_args(tmp_path, "--json", "--update-state")) == 1
    cap = capsys.readouterr()
    assert cap.out == ""
    assert "no state.json" in cap.err
