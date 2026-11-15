from test_cli_attempts import save_fixture

from rusty_piano_coach.cli import main


def _show(d, *extra):
    return ["attempts", "show", "latest", "--attempts-dir", str(d), *extra]


def _wrong_sight_step(a):
    a["steps"][1].update(result="wrong", first_try=False, wrong_count=1, wrong_notes=[62])


def test_sight_problems_list_wrong_card(tmp_path, capsys):
    d = save_fixture(tmp_path, "sight-attempt.json", _wrong_sight_step)
    assert main(_show(d)) == 0
    lines = capsys.readouterr().out.splitlines()
    i = lines.index("Problems:")
    assert lines[i + 1] == "  card 2: E4 -> wrong played D4 1.1 s"


def test_sight_problems_none_when_all_first_try(tmp_path, capsys):
    d = save_fixture(tmp_path, "sight-attempt.json")
    assert main(_show(d)) == 0
    lines = capsys.readouterr().out.splitlines()
    i = lines.index("Problems:")
    assert lines[i + 1] == "  none"


def test_sight_all_steps_lists_every_card(tmp_path, capsys):
    d = save_fixture(tmp_path, "sight-attempt.json")
    assert main(_show(d, "--all-steps")) == 0
    lines = capsys.readouterr().out.splitlines()
    assert "  card 1: C4 -> hit 0.9 s" in lines
    assert "  card 2: E4 -> hit 1.1 s" in lines
    assert "  card 3: G4 -> hit 1.5 s" in lines


def test_sight_problem_marks_hinted(tmp_path, capsys):
    def mutate(a):
        _wrong_sight_step(a)
        a["steps"][1]["hinted"] = True

    d = save_fixture(tmp_path, "sight-attempt.json", mutate)
    assert main(_show(d)) == 0
    lines = capsys.readouterr().out.splitlines()
    assert "  card 2: E4 -> wrong played D4 (hinted) 1.1 s" in lines


def test_ear_problems_list_wrong_item(tmp_path, capsys):
    def mutate(a):
        a["steps"][1].update(result="wrong", first_try=False, wrong_count=1, wrong_notes=[62])

    d = save_fixture(tmp_path, "ear-attempt.json", mutate)
    assert main(_show(d)) == 0
    lines = capsys.readouterr().out.splitlines()
    assert "  item 2: E4 -> wrong played D4 replays 1 2.6 s" in lines
    assert any(line.startswith("Ear:") for line in lines)


def test_ear_problems_none_when_all_first_try(tmp_path, capsys):
    d = save_fixture(tmp_path, "ear-attempt.json")
    assert main(_show(d)) == 0
    out = capsys.readouterr().out
    lines = out.splitlines()
    i = lines.index("Problems:")
    assert lines[i + 1] == "  none"
    assert "3 of 3" in out
