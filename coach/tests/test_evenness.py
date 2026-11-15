import json
from datetime import date, datetime, timezone
from pathlib import Path

from evidence_fixtures import make_attempt, make_steps, tiny_tree, write_attempts

from rusty_piano_coach import evenness, runs, trends

FIXTURE = Path(__file__).parents[1] / "web" / "tests" / "fixtures" / "evenness-cases.json"
EVEN = [500 * i for i in range(16)]
UNEVEN = [0, 500, 1000, 1700, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500]
MID = [0, 300, 600, 900, 1260]


def fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def scale_steps(onsets):
    steps = make_steps(["hit"] * len(onsets))
    for i, step in enumerate(steps):
        step["played"][0]["page_ms"] = onsets[i]
    return steps


def run_of(score, onsets):
    return runs.runs_of_attempt(make_attempt(score=score, steps=scale_steps(onsets)), timezone.utc)[0]


def test_fixture_cases():
    for c in fixture()["cases"]:
        got = evenness.compute(c["input"]["steps"], score_id=c["input"]["score_id"], hands=c["input"]["hands"])
        assert got == c["expected"], c["name"]


def test_constants_match_fixture():
    assert evenness.CONSTANTS == fixture()["constants"]


def test_scores():
    assert evenness.evenness_score(0.14) == 50
    assert evenness.alignment_score(67.5) == 50
    assert evenness.evenness_score(0.03) == 100
    assert evenness.evenness_score(0.25) == 0


def test_attempt_evenness():
    got = evenness.attempt_evenness(make_attempt(score="scales:c-major-1oct-rh", steps=scale_steps(EVEN)))
    assert got["combined"] == 100
    assert got["right"]["score"] == 100
    saved = make_attempt(score="scales:c-major-1oct-rh", steps=scale_steps(EVEN))
    saved["evenness"] = {"combined": 42}
    assert evenness.attempt_evenness(saved) == {"combined": 42}
    assert evenness.attempt_evenness(make_attempt(score="gen:t1-quarters-rh")) is None


def test_clean_run_needs_evenness():
    gate = tiny_tree()["default_gates"]["good"]
    assert runs.is_clean(run_of("scales:c-major-1oct-rh", EVEN), gate) is True
    assert runs.is_clean(run_of("scales:c-major-1oct-rh", UNEVEN), gate) is False
    assert runs.is_clean(run_of("gen:t1-quarters-rh", UNEVEN), gate) is True
    assert runs.is_clean(run_of("scales:c-major-1oct-rh", MID), gate) is False
    assert runs.is_clean(run_of("scales:c-major-1oct-rh", MID), {**gate, "evenness": 0.7}) is True
    assert runs.run_evenness(run_of("scales:c-major-1oct-rh", MID)) == 0.76
    assert runs.run_evenness(run_of("gen:t1-quarters-rh", EVEN)) is None
    assert runs.is_clean(run_of("scales:c-major-1oct-rh", [0, 500, 1000]), gate) is False


def test_evidence_reports_evenness(tmp_path):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "tree.json").write_text(json.dumps(tiny_tree()), encoding="utf-8")
    attempts_dir = tmp_path / "attempts"
    write_attempts(
        attempts_dir,
        [
            make_attempt(
                id="attempt-20261101-100000-aaaaa1",
                drill_id="s1.c-major-rh",
                score="scales:c-major-1oct-rh",
                steps=scale_steps(EVEN),
            ),
            make_attempt(
                id="attempt-20261101-100000-aaaaa2",
                drill_id="t1.q",
                started_at="2026-11-01T11:00:00+00:00",
                steps=scale_steps(EVEN),
            ),
        ],
    )
    ev = trends.build_evidence(
        attempts_dir=attempts_dir,
        reports_dir=tmp_path / "reports",
        plan_dir=plan_dir,
        scores_dir=tmp_path / "scores",
        since=None,
        today=date(2026, 11, 5),
        tz=timezone.utc,
        now=datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc),
    )
    assert ev["drills"]["s1.c-major-rh"]["evenness"] == 100
    assert ev["drills"]["s1.c-major-rh"]["hands_alignment"] is None
    assert "evenness" not in ev["drills"]["t1.q"]
