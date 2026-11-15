import copy
import json
from datetime import date, datetime, timezone

from rusty_piano_coach import plan, trends
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.server import handle_request


def s1(tree):
    return next(n for n in tree["nodes"] if n["id"] == "S1")


def make_old():
    old = plan.load_json(plan.SEED_TREE)
    s1(old)["requires"] = ["K1"]
    expected = copy.deepcopy(old)
    s1(expected)["requires"] = []
    return old, expected


def dump(tree):
    return json.dumps(tree, indent=2, ensure_ascii=False) + "\n"


def write(tmp_path, data):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "tree.json").write_bytes(data)
    return plan_dir


def no_tmp(plan_dir):
    return not list(plan_dir.glob(".tree.json.*.tmp")) and not list(plan_dir.glob("*.tmp"))


def test_lf_file(tmp_path):
    old, expected = make_old()
    plan_dir = write(tmp_path, dump(old).encode())
    assert plan.migrate_tree(plan_dir) is True
    new = (plan_dir / "tree.json").read_bytes()
    assert new == dump(expected).encode()
    k2 = next(n for n in json.loads(new)["nodes"] if n["id"] == "K2")
    assert k2["requires"] == ["K1"]


def test_crlf_file(tmp_path):
    old, expected = make_old()
    plan_dir = write(tmp_path, dump(old).replace("\n", "\r\n").encode())
    assert plan.migrate_tree(plan_dir) is True
    new = (plan_dir / "tree.json").read_bytes()
    assert new == dump(expected).replace("\n", "\r\n").encode()
    assert new.count(b"\n") == new.count(b"\r\n")


def test_one_line_file(tmp_path):
    old, expected = make_old()
    plan_dir = write(tmp_path, json.dumps(old).encode())
    assert plan.migrate_tree(plan_dir) is True
    new = (plan_dir / "tree.json").read_bytes()
    assert json.loads(new) == expected
    assert b"\n" not in new


def test_other_requires_untouched(tmp_path):
    old, _ = make_old()
    s1(old)["requires"] = ["K1", "R1"]
    data = dump(old).encode()
    plan_dir = write(tmp_path, data)
    path = plan_dir / "tree.json"
    before = path.stat().st_mtime_ns
    assert plan.migrate_tree(plan_dir) is False
    assert path.read_bytes() == data
    assert path.stat().st_mtime_ns == before


def test_empty_requires_untouched(tmp_path):
    old, _ = make_old()
    s1(old)["requires"] = []
    data = dump(old).encode()
    plan_dir = write(tmp_path, data)
    path = plan_dir / "tree.json"
    before = path.stat().st_mtime_ns
    assert plan.migrate_tree(plan_dir) is False
    assert path.read_bytes() == data
    assert path.stat().st_mtime_ns == before


def test_idempotent(tmp_path):
    old, _ = make_old()
    plan_dir = write(tmp_path, dump(old).encode())
    assert plan.migrate_tree(plan_dir) is True
    data = (plan_dir / "tree.json").read_bytes()
    assert plan.migrate_tree(plan_dir) is False
    assert (plan_dir / "tree.json").read_bytes() == data


def test_missing_file(tmp_path):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    assert plan.migrate_tree(plan_dir) is False
    assert no_tmp(plan_dir)


def test_invalid_json(tmp_path):
    plan_dir = write(tmp_path, b"{not json")
    assert plan.migrate_tree(plan_dir) is False
    assert no_tmp(plan_dir)


def test_tree_without_s1(tmp_path):
    old, _ = make_old()
    old["nodes"] = [n for n in old["nodes"] if n["id"] != "S1"]
    plan_dir = write(tmp_path, dump(old).encode())
    assert plan.migrate_tree(plan_dir) is False
    assert no_tmp(plan_dir)


def test_server_fixes_tree(tmp_path):
    old, _ = make_old()
    plan_dir = write(tmp_path, dump(old).encode())
    r = handle_request(tmp_path / "lib", "/api/plan", "GET", {"Host": "127.0.0.1:8765"}, Jobs(), plan_dir=plan_dir)
    assert r.status == 200
    assert s1(json.loads(r.body)["tree"])["requires"] == []
    assert s1(json.loads((plan_dir / "tree.json").read_bytes()))["requires"] == []


def test_build_evidence_warns(tmp_path):
    old, _ = make_old()
    plan_dir = write(tmp_path, dump(old).encode())
    ev = trends.build_evidence(
        attempts_dir=tmp_path / "attempts",
        reports_dir=tmp_path / "reports",
        plan_dir=plan_dir,
        scores_dir=tmp_path / "scores",
        since=None,
        today=date(2026, 11, 5),
        tz=timezone.utc,
        now=datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc),
    )
    assert "tree.json: S1 no longer requires K1 (one-off fix)" in ev["warnings"]
    assert s1(json.loads((plan_dir / "tree.json").read_bytes()))["requires"] == []
