import pytest

from rusty_piano_coach.cli import main

HELP_ARGV = [
    [],
    ["scores"],
    ["scores", "sources"],
    ["scores", "sync"],
    ["scores", "fetch-archive"],
    ["scores", "download"],
    ["scores", "delete"],
    ["scores", "import"],
    ["scores", "search"],
    ["scores", "list"],
    ["scores", "show"],
    ["attempts"],
    ["attempts", "list"],
    ["attempts", "show"],
    ["analyse"],
    ["plan"],
    ["plan", "check"],
    ["plan", "init"],
    ["plan", "link"],
    ["evidence"],
    ["sight"],
    ["sight", "add-drills"],
    ["ear"],
    ["ear", "add-drills"],
    ["fingering"],
    ["log"],
    ["serve"],
]


def help_text(capsys, argv):
    with pytest.raises(SystemExit) as e:
        main([*argv, "--help"])
    assert e.value.code == 0
    return capsys.readouterr().out


@pytest.mark.parametrize("argv", HELP_ARGV, ids=lambda a: " ".join(a) or "coach")
def test_help(capsys, argv):
    assert "usage:" in help_text(capsys, argv)


def error_cases(tmp_path):
    empty_plan = tmp_path / "empty_plan"
    empty_plan.mkdir()
    empty_att = tmp_path / "empty_att"
    empty_att.mkdir()
    lib = tmp_path / "lib"
    lib.mkdir()
    init_plan = tmp_path / "init_plan"
    bad_plan = tmp_path / "bad_plan"
    bad_plan.mkdir()
    (bad_plan / "tree.json").write_text("{", encoding="utf-8")
    p, a, d = str(empty_plan), str(empty_att), str(lib)
    return [
        ["plan", "check", "--plan-dir", p],
        ["plan", "link", "x.y", "--plan-dir", p],
        ["evidence", "--update-state", "--plan-dir", p, "--attempts-dir", a],
        ["plan", "link", "--score", "x", "--bars", "5-x"],
        ["plan", "link", "--score", "x", "--target", "0"],
        ["attempts", "show", "latest", "--attempts-dir", a],
        ["attempts", "show", "no-such-id", "--attempts-dir", a],
        ["analyse", "--attempt", "latest", "--attempts-dir", a, "--data-dir", d],
        ["analyse", "--attempt", "no-such-id", "--attempts-dir", a, "--data-dir", d],
        ["evidence", "--since", "garbage", "--attempts-dir", a, "--plan-dir", p],
        ["evidence", "--today", "2026-13-01", "--attempts-dir", a, "--plan-dir", p],
        ["evidence", "--json", "--since", "garbage", "--attempts-dir", a, "--plan-dir", p],
        ["sight", "add-drills", "--plan-dir", p],
        ["ear", "add-drills", "--plan-dir", p],
        ["sight", "add-drills", "--plan-dir", str(bad_plan)],
        ["ear", "add-drills", "--plan-dir", str(bad_plan)],
        ["fingering", "--data-dir", d, "--id", "no-such"],
        ["fingering", "--data-dir", d, "--source", "no-such"],
        ["log", "--days", "0"],
        ["log", "--today", "bad"],
        ["scores", "show", "999999", "--data-dir", d],
        ["scores", "import", str(tmp_path / "missing.musicxml"), "--data-dir", d],
        ["scores", "search", "--data-dir", d],
        ["scores", "delete", "999999", "--data-dir", d],
    ] + [["plan", "link", "no-such.drill", "--plan-dir", str(init_plan)]]


@pytest.fixture
def init_then_cases(tmp_path):
    assert main(["plan", "init", "--plan-dir", str(tmp_path / "init_plan")]) == 0
    return error_cases(tmp_path)


@pytest.mark.parametrize("index", range(25))
def test_error_path_no_traceback(init_then_cases, tmp_path, capsys, index, monkeypatch):
    monkeypatch.setenv("RUSTY_PIANO_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("RUSTY_PIANO_SCORES_DIR", str(tmp_path / "scores"))
    argv = init_then_cases[index]
    capsys.readouterr()
    try:
        code = main(argv)
    except SystemExit as e:
        code = e.code
    cap = capsys.readouterr()
    assert "Traceback" not in cap.out + cap.err, argv
    if argv[:2] == ["scores", "search"] and len(argv) == 4:
        assert code == 0
        return
    assert code in (1, 2), (argv, code, cap)


@pytest.mark.parametrize(
    "argv, texts",
    [
        (
            ["plan", "link"],
            ["which hands the page plays and expects", "tempo percent (1-300)", "follower mode: wait or live", "loop the bars"],
        ),
        (
            ["evidence"],
            ["RUSTY_PIANO_DATA_DIR/attempts", "RUSTY_PIANO_DATA_DIR/reports", "RUSTY_PIANO_DATA_DIR/plan", "RUSTY_PIANO_DATA_DIR/sessions"],
        ),
        (["analyse"], ["RUSTY_PIANO_DATA_DIR/sessions", "RUSTY_PIANO_DATA_DIR/attempts", "RUSTY_PIANO_DATA_DIR/reports"]),
    ],
    ids=["plan-link", "evidence", "analyse"],
)
def test_fixed_help_texts(capsys, argv, texts):
    out = " ".join(help_text(capsys, argv).split())
    for text in texts:
        assert text in out
