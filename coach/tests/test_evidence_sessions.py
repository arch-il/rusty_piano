import json
from datetime import date, datetime, timezone

from evidence_fixtures import make_attempt, make_report, tiny_tree, write_attempts, write_reports
from mid_fixtures import engine_like, notes_to_events, write

from rusty_piano_coach import gates, runs, sessions, trends
from rusty_piano_coach.cli import main

UTC = timezone.utc
NOW = datetime(2026, 11, 5, 12, 0, tzinfo=UTC)


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


def make_session(folder, name):
    folder.mkdir(parents=True, exist_ok=True)
    return write(folder / name, engine_like(notes_to_events([(60, 0, 300000, 80)])))


def test_sessions_block(tmp_path):
    folder = tmp_path / "sessions"
    free = make_session(folder, "session-20261102-200000.mid")
    reported = make_session(folder, "session-20261103-200000.mid")
    overlapped = make_session(folder, "session-20261104-200000.mid")
    report = make_report()
    report["input"]["midi_path"] = str(reported)
    start = sessions.read_midi(overlapped).started_at
    attempt = make_attempt(started_at=start.replace(minute=1).isoformat(), duration_ms=60000)
    ev = build(tmp_path, [attempt], [report], sessions_dir=folder)
    s = ev["sessions"]
    assert s["files"] == 3
    assert s["minutes"] == 15.0
    assert s["unanalysed_count"] == 1
    assert [u["file"] for u in s["unanalysed"]] == [free.name]
    assert s["unanalysed"][0]["minutes"] == 5.0
    assert ev["inputs"]["sessions"] == 3


def test_silences_over_two_minutes_are_cut(tmp_path):
    folder = tmp_path / "sessions"
    folder.mkdir()
    notes = [(60, 0, 60000, 80), (62, 360000, 420000, 80)]
    write(folder / "session-20261102-200000.mid", engine_like(notes_to_events(notes)))
    s = build(tmp_path, sessions_dir=folder)["sessions"]
    assert s["minutes"] == 2.0
    assert s["unanalysed"][0]["minutes"] == 2.0


def test_gap_of_exactly_two_minutes_counts(tmp_path):
    folder = tmp_path / "sessions"
    folder.mkdir()
    notes = [(60, 0, 60000, 80), (62, 180000, 240000, 80)]
    write(folder / "session-20261102-200000.mid", engine_like(notes_to_events(notes)))
    s = build(tmp_path, sessions_dir=folder)["sessions"]
    assert s["minutes"] == 4.0


def test_since_filters_sessions(tmp_path):
    folder = tmp_path / "sessions"
    make_session(folder, "session-20261102-200000.mid")
    make_session(folder, "session-20261103-200000.mid")
    make_session(folder, "session-20261104-200000.mid")
    ev = build(tmp_path, since=datetime(2026, 11, 2, 21, 0, tzinfo=UTC), sessions_dir=folder)
    assert ev["sessions"]["files"] == 2


def test_old_session_is_not_parsed_with_since(tmp_path, monkeypatch):
    folder = tmp_path / "sessions"
    folder.mkdir()
    (folder / "session-20261001-200000.mid").write_bytes(b"not midi")
    make_session(folder, "session-20261104-200000.mid")
    calls = []
    real = sessions.read_midi

    def spy(path):
        calls.append(path.name)
        return real(path)

    monkeypatch.setattr(sessions, "read_midi", spy)
    ev = build(tmp_path, since=datetime(2026, 11, 3, tzinfo=UTC), sessions_dir=folder)
    assert calls == ["session-20261104-200000.mid"]
    assert ev["inputs"]["skipped"] == []
    assert ev["sessions"]["files"] == 1


def test_unanalysed_is_capped(tmp_path):
    folder = tmp_path / "sessions"
    for n in range(1, 26):
        make_session(folder, f"session-202610{n:02d}-200000.mid")
    s = build(tmp_path, sessions_dir=folder)["sessions"]
    assert s["files"] == 25
    assert s["unanalysed_count"] == 25
    assert len(s["unanalysed"]) == 20
    assert s["unanalysed"][-1]["file"] == "session-20261025-200000.mid"


def test_bad_session_is_skipped(tmp_path):
    folder = tmp_path / "sessions"
    folder.mkdir()
    (folder / "session-20261104-210000.mid").write_bytes(b"not midi")
    ev = build(tmp_path, sessions_dir=folder)
    assert any("session-20261104-210000.mid" in s for s in ev["inputs"]["skipped"])
    assert ev["sessions"]["files"] == 0


def test_no_sessions_dir(tmp_path):
    ev = build(tmp_path)
    assert ev["sessions"] == {"files": 0, "minutes": 0.0, "unanalysed_count": 0, "unanalysed": []}
    assert ev["inputs"]["sessions"] == 0


def cli_args(tmp_path, *extra):
    ad, rd, pd, sd = setup_dirs(tmp_path)
    return [
        "evidence",
        "--attempts-dir", str(ad),
        "--reports-dir", str(rd),
        "--plan-dir", str(pd),
        "--data-dir", str(sd),
        "--sessions-dir", str(tmp_path / "sessions"),
        "--today", "2026-11-05",
        *extra,
    ]


def test_cli_text_and_flag(tmp_path, capsys):
    make_session(tmp_path / "sessions", "session-20261104-200000.mid")
    assert main(cli_args(tmp_path, "--utc")) == 0
    assert "Sessions: 1 recorded (5 min), 1 not analysed" in capsys.readouterr().out


def test_local_zone_is_used(tmp_path, monkeypatch):
    seen = []
    real = trends.build_evidence

    def wrapped(**kw):
        seen.append(kw["tz"])
        return real(**kw)

    monkeypatch.setattr(trends, "build_evidence", wrapped)
    assert main(cli_args(tmp_path)) == 0
    assert seen == [trends.LOCAL]
    assert seen[0] is trends.LOCAL


def test_unpractised_nodes_get_no_gates():
    tree = tiny_tree()
    state = {"version": 1, "nodes": {"R1": {"level": 0, "gates": {"good": {"met": False}}}}, "habits": []}
    run_list = runs.load_runs([make_attempt(drill_id="t1.q")], UTC)
    progress = gates.node_progress(tree, state, run_list, date(2026, 11, 5))
    new = gates.apply_to_state(state, progress)
    assert "gates" in new["nodes"]["T1"]
    assert "gates" not in new["nodes"]["T2"]
    assert "gates" not in new["nodes"]["R1"]
    assert new["nodes"]["T2"]["runs"] == 0
