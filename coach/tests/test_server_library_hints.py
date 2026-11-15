from test_server_scales_list import add, get


def test_capped_true_when_search_hits_limit(tmp_path):
    d = tmp_path / "lib"
    add(d, "local:waltz-a", "local", "Waltz alpha")
    add(d, "local:waltz-b", "local", "Waltz beta")
    assert get(d, "/api/scores?q=waltz&limit=2")["capped"] is True
    assert get(d, "/api/scores?q=waltz&limit=5")["capped"] is False
    assert get(d, "/api/scores?limit=2")["capped"] is False


def test_hidden_counts_scales_only_without_query(tmp_path):
    d = tmp_path / "lib"
    add(d, "scales:a-major-1oct-rh", "scales", "A major scale, 1 octave, right hand")
    add(d, "scales:b-major-1oct-rh", "scales", "B major scale, 1 octave, right hand")
    add(d, "local:zebra", "local", "Zebra waltz")
    assert get(d, "/api/scores")["hidden"] == 2
    assert get(d, "/api/scores?q=scale")["hidden"] == 0
