import json

from rusty_piano_coach import plan
from rusty_piano_coach.jobs import Jobs
from rusty_piano_coach.server import handle_request, make_server

def get(tmp_path, plan_dir, host="127.0.0.1:8765"):
    return handle_request(tmp_path / "lib", "/api/plan", "GET", {"Host": host}, Jobs(), plan_dir=plan_dir)


def make_state():
    return {
        "version": 1,
        "kind": "rusty_piano.state",
        "updated_at": "2026-11-05T07:00:00Z",
        "last_review": None,
        "plan_id": None,
        "nodes": {},
        "habits": [],
    }


def test_no_tree_is_404(tmp_path):
    r = get(tmp_path, tmp_path / "plan")
    assert r.status == 404
    assert json.loads(r.body)["error"] == "No skill tree yet. Run /coach in Claude Code to set up your plan."


def test_tree_without_state(tmp_path):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "tree.json").write_text(json.dumps(plan.load_json(plan.SEED_TREE)), encoding="utf-8")
    r = get(tmp_path, plan_dir)
    assert r.status == 200
    body = json.loads(r.body)
    assert body["tree"] == plan.load_json(plan.SEED_TREE)
    assert body["state"] is None
    assert any("state.json: missing" in p for p in body["problems"])


def test_tree_with_state(tmp_path):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "tree.json").write_text(json.dumps(plan.load_json(plan.SEED_TREE)), encoding="utf-8")
    (plan_dir / "state.json").write_text(json.dumps(make_state()), encoding="utf-8")
    r = get(tmp_path, plan_dir)
    assert r.status == 200
    body = json.loads(r.body)
    assert body["state"] == make_state()
    assert body["problems"] == []


def test_state_level_above_max_is_a_problem(tmp_path):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "tree.json").write_text(json.dumps(plan.load_json(plan.SEED_TREE)), encoding="utf-8")
    state = make_state()
    state["nodes"]["R1"] = {"level": 3, "max_level": 1}
    (plan_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    r = get(tmp_path, plan_dir)
    assert r.status == 200
    assert "state.json: nodes.R1: level 3 is above the gate floor (max 1)" in json.loads(r.body)["problems"]


def test_broken_tree_is_500(tmp_path):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "tree.json").write_text("{not json", encoding="utf-8")
    r = get(tmp_path, plan_dir)
    assert r.status == 500
    assert "tree.json is not valid JSON" in json.loads(r.body)["error"]


def test_broken_state_is_reported(tmp_path):
    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "tree.json").write_text(json.dumps(plan.load_json(plan.SEED_TREE)), encoding="utf-8")
    (plan_dir / "state.json").write_text("{not json", encoding="utf-8")
    r = get(tmp_path, plan_dir)
    assert r.status == 200
    body = json.loads(r.body)
    assert body["state"] is None
    assert any("state.json is not valid JSON" in p for p in body["problems"])


def test_evil_host_is_403(tmp_path):
    r = get(tmp_path, tmp_path / "plan", host="evil.example")
    assert r.status == 403


def test_post_is_404(tmp_path):
    r = handle_request(
        tmp_path / "lib", "/api/plan", "POST", {"Host": "127.0.0.1:8765", "Origin": None}, Jobs(), plan_dir=tmp_path / "plan"
    )
    assert r.status == 404


def test_make_server_takes_plan_dir(tmp_path):
    server = make_server(tmp_path / "lib", 0, plan_dir=tmp_path / "plan")
    try:
        assert server.plan_dir == tmp_path / "plan"
    finally:
        server.server_close()
