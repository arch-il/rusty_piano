"""Habit detection from runs, attempts and reports: the 15 detectors of the design. Pure: works only on its inputs."""

import gc

from . import plan as plan_mod
from . import runs as runs_mod

MIN_ATTEMPTS = 5
LONG_PIECE_BARS = 8
TOP_SHARE = 0.8
FULL_SHARE = 0.9
ISOLATE_BARS = 4
TEMPO_RUNS = 4
TEMPO_ACCURACY = 0.85
WEAK_MIN_RUNS = 6
STRONG_SHARE = 0.7
WEAK_SHARE = 0.1
RESTART_COUNT = 3
RUSH_SAMPLES = 10
RUSH_MS = 30
DRIFT_REPORTS = 3
DRIFT_BPM = 0.5
SLOW_SAMPLES = 8
SLOW_MS = 40
HOLD_MIN = 8
HOLD_SHORT_SHARE = 0.25
LH_GROUPS = 8
LH_MS = 30
FLAT_NOTES = 50
FLAT_SPREAD = 12
SAME_WRONG_ATTEMPTS = 3
KEY_ERRORS = 3
REST_MIN_Q = 0.5
REST_GAP_Q = 2.0
REST_SAMPLES = 8
REST_EARLY_MS = 60
RHYTHM_RUNS = 3
RHYTHM_MS = 80
RHYTHM_MIN_STEPS = 4
RHYTHM_NEIGHBOURS = 3
JUMP_RUNS = 3
JUMP_FAIL_SHARE = 0.5
JUMP_MARGIN = 0.3
PITCH_OK = ("hit", "early", "late")
_TIMED_OUTCOMES = ("hit", "early", "late")

TITLES = {
    "start_at_bar_1": "Always starts at the top of the piece",
    "plays_through_mistakes": "Plays through mistakes instead of fixing the hard bars",
    "tempo_too_high": "Tempo set too high for now",
    "avoids_weak_node": "Keeps practising what is already good, avoids the weak skill",
    "restarts_same_spot": "Stops and restarts at the same spot",
    "rushing": "Rushes after a mistake or speeds up",
    "slows_at_hard_bars": "Slows down at hard bars instead of keeping the pulse",
    "cuts_long_notes": "Cuts long notes short",
    "left_hand_late": "Left hand late against the right",
    "flat_dynamics": "Everything at one loudness",
    "same_wrong_pitch": "Plays the same wrong note at the same spot",
    "key_signature_semitone": "Forgets the key signature",
    "rests_not_counted": "Does not count rests (comes in early after a rest)",
    "rhythm_consistently_wrong": "Plays the same rhythm wrong in the same place",
    "repeats_not_followed": "Does not follow repeats or jumps",
}

MAJOR_FIFTHS = {
    "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5, "F#": 6, "C#": 7,
    "F": -1, "Bb": -2, "Eb": -3, "Ab": -4, "Db": -5, "Gb": -6, "Cb": -7,
}
MINOR_FIFTHS = {
    "A": 0, "E": 1, "B": 2, "F#": 3, "C#": 4, "G#": 5, "D#": 6, "A#": 7,
    "D": -1, "G": -2, "C": -3, "F": -4, "Bb": -5, "Eb": -6, "Ab": -7,
}
SHARP_ORDER = [6, 1, 8, 3, 10, 5, 0]
FLAT_ORDER = [10, 3, 8, 1, 6, 11, 4]


def parse_key(text) -> int | None:
    if not isinstance(text, str):
        return None
    parts = text.split()
    if len(parts) < 2:
        return None
    tonic = parts[0]
    tonic = tonic[:1].upper() + tonic[1:].replace("-", "b")
    mode = parts[1].lower()
    if mode == "major":
        return MAJOR_FIFTHS.get(tonic)
    if mode == "minor":
        return MINOR_FIFTHS.get(tonic)
    return None


def _mean(values):
    return sum(values) / len(values) if values else None


def _r3(value):
    return None if value is None else round(value, 3)


def _cand(cid, count, detail, score=None, bars=(), node=None, drill=None):
    return {
        "id": cid,
        "title": TITLES[cid],
        "where": {"score": score, "bars": list(bars), "node": node, "drill": drill},
        "count": count,
        "detail": detail,
    }


def _group(items, key):
    out: dict = {}
    for item in items:
        out.setdefault(key(item), []).append(item)
    return out


def _offset(step):
    off = step.get("offset_ms")
    if off is None or step.get("outcome") not in _TIMED_OUTCOMES:
        return None
    return off


def _live(runs):
    return [r for r in runs if r.mode == "live"]


class _Prep:
    """Per-detect() cache: per-run offsets and consecutive pairs, per-score groups and bar stats, each computed once."""

    def __init__(self, runs):
        self.all_groups = sorted(_group(runs, lambda r: r.score_id).items())
        live = _live(runs)
        self.live_groups = sorted(_group(live, lambda r: r.score_id).items())
        self.live = live
        self._offs = {}
        self._pairs = {}
        self._stats = {}

    def offsets(self, r):
        key = id(r)
        got = self._offs.get(key)
        if got is None:
            got = self._offs[key] = [_offset(s) for s in r.steps]
        return got

    def pairs(self, r):
        """(pairs, bars) of a run: pairs are (prev, cur, offset of cur, rest basis); prev and cur are (result, bar, beat)."""
        key = id(r)
        got = self._pairs.get(key)
        if got is None:
            got = self._pairs[key] = _run_pairs(r.steps)
        return got

    def bar_stats(self, kind, sid, group):
        key = (kind, sid)
        got = self._stats.get(key)
        if got is None:
            got = self._stats[key] = runs_mod.bar_stats(group)
        return got


def _attempt_range(a):
    rng = (a.get("practice") or {}).get("range")
    return (rng["from"], rng["to"]) if isinstance(rng, dict) else None


def _step_accuracy(steps):
    steps = [s for s in steps if s.get("result") != "pending"]
    if not steps:
        return None
    return sum(1 for s in steps if s.get("result") in runs_mod.CORRECT_RESULTS) / len(steps)


def _real_scores(attempts):
    by_score = _group(attempts, lambda a: a["score"]["id"])
    return {sid: group for sid, group in by_score.items() if not sid.startswith(("gen:", "sight:", "ear:"))}


def _bars_of(attempts):
    return [s["bar"] for a in attempts for s in a.get("steps") or [] if s.get("bar") is not None]


def _start_at_bar_1(attempts):
    out = []
    for sid, group in sorted(_real_scores(attempts).items()):
        bars = _bars_of(group)
        if len(group) < MIN_ATTEMPTS or not bars or max(bars) < LONG_PIECE_BARS:
            continue
        top = 0
        for a in group:
            rng = _attempt_range(a)
            first = (a.get("plan") or {}).get("first_bar") or 1
            if rng is None or rng[0] <= first:
                top += 1
        share = top / len(group)
        if share < TOP_SHARE:
            continue
        mid = (min(bars) + max(bars)) / 2
        steps = [s for a in group for s in a.get("steps") or [] if s.get("bar") is not None]
        first_half = _step_accuracy([s for s in steps if s["bar"] <= mid])
        second_half = _step_accuracy([s for s in steps if s["bar"] > mid])
        out.append(
            _cand(
                "start_at_bar_1",
                len(group),
                {
                    "attempts": len(group),
                    "share": _r3(share),
                    "first_half_accuracy": _r3(first_half),
                    "second_half_accuracy": _r3(second_half),
                },
                score=sid,
            )
        )
    return out


def _plays_through_mistakes(prep, attempts):
    out = []
    all_groups = dict(prep.all_groups)
    for sid, group in sorted(_real_scores(attempts).items()):
        full = sum(1 for a in group if _attempt_range(a) is None) / len(group)
        if full < FULL_SHARE:
            continue
        hard = runs_mod.hard_bars(prep.bar_stats("all", sid, all_groups.get(sid, [])))
        if not hard:
            continue
        isolated = False
        for a in group:
            rng = _attempt_range(a)
            if rng and rng[1] - rng[0] + 1 <= ISOLATE_BARS and any(rng[0] <= b <= rng[1] for b in hard):
                isolated = True
                break
        if isolated:
            continue
        out.append(
            _cand(
                "plays_through_mistakes",
                len(hard),
                {"attempts": len(group), "full_share": _r3(full)},
                score=sid,
                bars=hard,
            )
        )
    return out


def _tempo_too_high(runs, tree):
    out = []
    gate = tree["default_gates"]["good"] if tree else None
    for sid, group in sorted(_group(_live(runs), lambda r: r.score_id).items()):
        group = [r for r in group if runs_mod.run_accuracy(r) is not None]
        if not group:
            continue
        top = max(r.tempo_percent for r in group)
        at_top = [r for r in group if r.tempo_percent == top]
        if len(at_top) < TEMPO_RUNS:
            continue
        mean_acc = _mean([runs_mod.run_accuracy(r) for r in at_top])
        if mean_acc >= TEMPO_ACCURACY:
            continue
        if gate and any(runs_mod.is_clean(r, gate) for r in at_top):
            continue
        lower = [runs_mod.run_accuracy(r) for r in group if r.tempo_percent < top]
        out.append(
            _cand(
                "tempo_too_high",
                len(at_top),
                {
                    "tempo_percent": top,
                    "runs": len(at_top),
                    "mean_accuracy": _r3(mean_acc),
                    "lower_tempo_accuracy": _r3(_mean(lower)),
                },
                score=sid,
            )
        )
    return out


def _avoids_weak_node(runs, tree, state):
    if not tree:
        return []
    index = plan_mod.drill_index(tree)
    nodes_state = (state or {}).get("nodes") or {}

    def level(nid):
        return (nodes_state.get(nid) or {}).get("level", 0)

    per_node: dict = {}
    for r in runs:
        if r.drill_id in index:
            nid = index[r.drill_id][0]["id"]
            per_node[nid] = per_node.get(nid, 0) + 1
    total = sum(per_node.values())
    if total < WEAK_MIN_RUNS:
        return []
    strong = sum(n for nid, n in per_node.items() if level(nid) >= 2) / total
    if strong < STRONG_SHARE:
        return []
    weak = {}
    for node in tree.get("nodes", []):
        nid = node["id"]
        if not all(level(req) >= 2 for req in node.get("requires", [])):
            continue
        if not node.get("drills") or level(nid) > 1:
            continue
        runs_n = per_node.get(nid, 0)
        if runs_n / total < WEAK_SHARE:
            weak[nid] = runs_n
    if not weak:
        return []
    return [
        _cand(
            "avoids_weak_node",
            len(weak),
            {"strong_share": _r3(strong), "weak_nodes": weak},
            node=next(iter(weak)),
        )
    ]


def _stop_bar(a):
    done = [s for s in a.get("steps") or [] if s.get("result") != "pending"]
    if not done:
        return None
    last = max(done, key=lambda s: (s.get("cycle") or 0, s.get("step") or 0))
    return last.get("bar")


def _restarts_same_spot(attempts):
    counts: dict = {}
    for a in attempts:
        if (a.get("practice") or {}).get("loop") or a.get("end") not in ("stop", "interrupted"):
            continue
        bar = _stop_bar(a)
        if bar is None:
            continue
        key = (a["score"]["id"], bar)
        counts[key] = counts.get(key, 0) + 1
    return [
        _cand("restarts_same_spot", n, {"stops": n}, score=sid, bars=[bar])
        for (sid, bar), n in counts.items()
        if n >= RESTART_COUNT
    ]


def _rushing(prep, reports):
    out = []
    after = []
    overall = []
    for r in prep.live:
        steps = r.steps
        offs = prep.offsets(r)
        total = len(steps)
        for i, s in enumerate(steps):
            off = offs[i]
            if off is not None:
                overall.append(off)
            if s.get("result") in ("wrong", "missed"):
                taken = 0
                for j in range(i + 1, total):
                    o = offs[j]
                    if o is None:
                        continue
                    after.append(o)
                    taken += 1
                    if taken == 3:
                        break
    if len(after) >= RUSH_SAMPLES and _mean(after) <= _mean(overall) - RUSH_MS:
        out.append(
            _cand(
                "rushing",
                len(after),
                {
                    "kind": "after_mistakes",
                    "after_mean_ms": round(_mean(after), 1),
                    "overall_mean_ms": round(_mean(overall), 1),
                    "samples": len(after),
                },
            )
        )
    drifts = [
        r["summary"]["drift_bpm_per_bar"]
        for r in reports
        if isinstance(r.get("summary"), dict) and r["summary"].get("drift_bpm_per_bar") is not None
    ]
    if len(drifts) >= DRIFT_REPORTS and _mean(drifts) >= DRIFT_BPM:
        out.append(
            _cand(
                "rushing",
                len(drifts),
                {"kind": "speeding_up", "mean_drift": round(_mean(drifts), 3), "reports": len(drifts)},
            )
        )
    return out


def _slows_at_hard_bars(prep):
    out = []
    for sid, group in prep.live_groups:
        hard = runs_mod.hard_bars(prep.bar_stats("live", sid, group))
        if not hard:
            continue
        hard_set = set(hard)
        in_hard = []
        other = []
        for r in group:
            for s, off in zip(r.steps, prep.offsets(r)):
                if off is None:
                    continue
                (in_hard if s.get("bar") in hard_set else other).append(off)
        if len(in_hard) < SLOW_SAMPLES or not other:
            continue
        diff = _mean(in_hard) - _mean(other)
        if diff >= SLOW_MS:
            out.append(
                _cand(
                    "slows_at_hard_bars",
                    len(in_hard),
                    {
                        "hard_mean_ms": round(_mean(in_hard), 1),
                        "other_mean_ms": round(_mean(other), 1),
                        "samples": len(in_hard),
                    },
                    score=sid,
                    bars=hard,
                )
            )
    return out


def _cuts_long_notes(runs):
    out = []
    for sid, group in sorted(_group(runs, lambda r: r.score_id).items()):
        checked = 0
        short_by_bar: dict = {}
        for r in group:
            for s in r.steps:
                for h in s.get("holds") or []:
                    checked += 1
                    if h.get("short"):
                        short_by_bar[s.get("bar")] = short_by_bar.get(s.get("bar"), 0) + 1
        short = sum(short_by_bar.values())
        if checked < HOLD_MIN or short / checked < HOLD_SHORT_SHARE:
            continue
        worst = sorted(short_by_bar.items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        out.append(
            _cand(
                "cuts_long_notes",
                short,
                {"holds_checked": checked, "short": short, "share": _r3(short / checked)},
                score=sid,
                bars=[b for b, _ in worst],
            )
        )
    return out


def _left_hand_late(reports):
    by_score: dict = {}
    for i, report in enumerate(reports):
        sid = (report.get("score") or {}).get("id")
        for n in report.get("notes") or []:
            if n.get("kind") != "match" or n.get("offset_ms") is None or n.get("part") is None:
                continue
            key = (i, n.get("loop"), n.get("score_q"))
            by_score.setdefault(sid, {}).setdefault(key, []).append(n)
    out = []
    for sid, groups in sorted(by_score.items(), key=lambda kv: str(kv[0])):
        diffs = []
        for notes in groups.values():
            left = [n["offset_ms"] for n in notes if n["part"] >= 1]
            right = [n["offset_ms"] for n in notes if n["part"] == 0]
            if left and right:
                diffs.append(_mean(left) - _mean(right))
        if len(diffs) >= LH_GROUPS and _mean(diffs) >= LH_MS:
            out.append(
                _cand(
                    "left_hand_late",
                    len(diffs),
                    {"mean_lag_ms": round(_mean(diffs), 1), "groups": len(diffs)},
                    score=sid,
                )
            )
    return out


def _flat_dynamics(attempts):
    velocities = [v for a in attempts for v in runs_mod.engine_velocities(a)]
    if len(velocities) < FLAT_NOTES:
        return []
    p10 = runs_mod.percentile(velocities, 0.1)
    p90 = runs_mod.percentile(velocities, 0.9)
    if p90 - p10 >= FLAT_SPREAD:
        return []
    return [_cand("flat_dynamics", len(velocities), {"notes": len(velocities), "p10": p10, "p90": p90})]


def _same_wrong_pitch(attempts):
    found: dict = {}
    for a in attempts:
        sid = a["score"]["id"]
        for s in a.get("steps") or []:
            expected = s.get("expected") or []
            for w in s.get("wrong") or []:
                note = w.get("note")
                if note is None or note in expected:
                    continue
                key = (sid, s.get("source_step"), note)
                entry = found.setdefault(key, {"bar": s.get("bar"), "beat": s.get("beat"), "expected": expected, "ids": set()})
                entry["ids"].add(a["id"])
    out = []
    for (sid, _, note), e in found.items():
        if len(e["ids"]) >= SAME_WRONG_ATTEMPTS:
            out.append(
                _cand(
                    "same_wrong_pitch",
                    len(e["ids"]),
                    {"beat": e["beat"], "expected": list(e["expected"]), "played": note, "attempts": len(e["ids"])},
                    score=sid,
                    bars=[e["bar"]],
                )
            )
    return out


def _key_signature_semitone(attempts, score_keys):
    out = []
    for sid, group in sorted(_group(attempts, lambda a: a["score"]["id"]).items()):
        key = (score_keys or {}).get(sid)
        fifths = parse_key(key)
        if not fifths:
            continue
        n = abs(fifths)
        if fifths > 0:
            altered, shift = set(SHARP_ORDER[:n]), -1
        else:
            altered, shift = set(FLAT_ORDER[:n]), 1
        records = []
        ids = set()
        for a in group:
            for s in a.get("steps") or []:
                for w in s.get("wrong") or []:
                    p = w.get("note")
                    for e in s.get("expected") or []:
                        if e % 12 in altered and p == e + shift:
                            records.append({"bar": s.get("bar"), "expected": e, "played": p})
                            ids.add(a["id"])
                            break
        if len(records) >= KEY_ERRORS and len(ids) >= 2:
            out.append(
                _cand(
                    "key_signature_semitone",
                    len(records),
                    {"key": key, "fifths": fifths, "examples": records[:5]},
                    score=sid,
                    bars=sorted({r["bar"] for r in records if r["bar"] is not None}),
                )
            )
    return out


def _num(v):
    t = type(v)
    return t is float or t is int


def _ordered(steps):
    return sorted((s for s in steps if isinstance(s, dict)), key=lambda s: (s.get("cycle") or 0, s.get("step") or 0))


def _run_pairs(steps):
    ordered = _ordered(steps)
    rows = []
    bars = set()
    for st in ordered:
        get = st.get
        bar = get("bar")
        if type(bar) is int or type(bar) is float:
            bars.add(bar)
        off = get("offset_ms")
        if off is not None and get("outcome") not in _TIMED_OUTCOMES:
            off = None
        rows.append((get("cycle"), get("step"), get("time_q"), get("length_q"), off, (get("result"), bar, get("beat"))))
    pairs = []
    if rows:
        pc, ps, pq, pl, _, pshort = rows[0]
        for row in rows[1:]:
            cc, cs, cq, _, off, short = row
            if pc == cc and _num(ps) and cs == ps + 1:
                basis = None
                if _num(pq) and _num(cq) and cq > pq:
                    if _num(pl):
                        if cq - pq - pl >= REST_MIN_Q:
                            basis = "note_length"
                    elif cq - pq >= REST_GAP_Q:
                        basis = "gap"
                pairs.append((pshort, short, off, basis))
            pc, ps, pq, pl, pshort = cc, cs, cq, row[3], short
    return pairs, bars


def _rests_not_counted(prep):
    out = []
    for sid, group in prep.live_groups:
        after = []
        other = []
        bases = set()
        per_bar: dict = {}
        for r in group:
            for prev, cur, off, basis in prep.pairs(r)[0]:
                if off is None or cur[0] not in PITCH_OK:
                    continue
                if basis is not None:
                    after.append(off)
                    bases.add(basis)
                    per_bar.setdefault(cur[1], []).append(off)
                else:
                    other.append(off)
        if len(after) < REST_SAMPLES or not other or _mean(after) > _mean(other) - REST_EARLY_MS:
            continue
        bars = sorted(
            bar for bar, offs in per_bar.items() if bar is not None and _mean(offs) <= _mean(other) - REST_EARLY_MS
        )[:5]
        out.append(
            _cand(
                "rests_not_counted",
                len(after),
                {
                    "after_rest_mean_ms": round(_mean(after), 1),
                    "other_mean_ms": round(_mean(other), 1),
                    "samples": len(after),
                    "basis": "note_length" if bases == {"note_length"} else "gap",
                },
                score=sid,
                bars=bars,
            )
        )
    return out


def _median(values):
    ordered = sorted(values)
    n = len(ordered)
    if n % 2:
        return ordered[n // 2]
    return (ordered[n // 2 - 1] + ordered[n // 2]) / 2


def _rhythm_consistently_wrong(prep):
    out = []
    for sid, group in prep.live_groups:
        spots: dict = {}
        for r in group:
            timed = []
            for prev, cur, off, basis in prep.pairs(r)[0]:
                if off is not None and basis is None and cur[0] in PITCH_OK:
                    timed.append((cur, off))
            if len(timed) < RHYTHM_MIN_STEPS:
                continue
            offs = [off for _, off in timed]
            per_run: dict = {}
            for i, (s, off) in enumerate(timed):
                before = offs[max(0, i - RHYTHM_NEIGHBOURS) : i]
                after = offs[i + 1 : i + 1 + RHYTHM_NEIGHBOURS]
                if len(before) < 2 or len(after) < 2:
                    continue
                db = off - _median(before)
                da = off - _median(after)
                if (db > 0 and da > 0) or (db < 0 and da < 0):
                    per_run.setdefault((s[1], s[2]), []).append(db if abs(db) <= abs(da) else da)
            for spot, vals in per_run.items():
                spots.setdefault(spot, {}).setdefault(r.attempt_id, []).append(_mean(vals))
        flagged = []
        for (bar, beat), by_run in spots.items():
            vals = [_mean(v) for v in by_run.values()]
            if len(vals) < RHYTHM_RUNS:
                continue
            if not (all(v > 0 for v in vals) or all(v < 0 for v in vals)):
                continue
            if any(abs(v) < RHYTHM_MS / 2 for v in vals):
                continue
            mean = _mean(vals)
            if abs(mean) >= RHYTHM_MS:
                flagged.append({"bar": bar, "beat": beat, "mean_ms": round(mean, 1), "runs": len(vals)})
        flagged.sort(key=lambda f: (-1 if f["bar"] is None else f["bar"], -1 if f["beat"] is None else f["beat"]))
        if flagged:
            out.append(
                _cand(
                    "rhythm_consistently_wrong",
                    len(flagged),
                    {"spots": flagged[:5], "spot_count": len(flagged)},
                    score=sid,
                    bars=sorted({f["bar"] for f in flagged if f["bar"] is not None}),
                )
            )
    return out


def _repeats_not_followed(prep):
    out = []
    for sid, group in prep.all_groups:
        jumps: dict = {}
        control: dict = {}
        for r in group:
            pairs, run_bars = prep.pairs(r)
            for prev, cur, _, _ in pairs:
                if prev[0] == "pending" or cur[0] == "pending":
                    continue
                failed = cur[0] in ("wrong", "missed")
                pb, cb = prev[1], cur[1]
                if _num(pb) and _num(cb) and (cb < pb or (cb == pb and _num(cur[2]) and _num(prev[2]) and cur[2] <= prev[2]) or (cb > pb + 1 and any(b in run_bars for b in range(pb + 1, cb)))):
                    rec = jumps.setdefault((pb, cb), {"cycles": {}})
                    c = rec["cycles"].setdefault(r.attempt_id, [0, 0])
                    c[0] += int(failed)
                    c[1] += 1
                else:
                    c = control.setdefault(cb, [0, 0])
                    c[0] += int(failed)
                    c[1] += 1
        total = sum(c[1] for c in control.values())
        overall = sum(c[0] for c in control.values()) / total if total else 0.0
        flagged = []
        for (fb, tb), rec in sorted(jumps.items()):
            failed_attempts = sum(1 for f, n in rec["cycles"].values() if f * 2 >= n)
            reached = len(rec["cycles"])
            if reached < JUMP_RUNS:
                continue
            share = failed_attempts / reached
            base = control[tb][0] / control[tb][1] if tb in control and control[tb][1] > 0 else overall
            if share >= JUMP_FAIL_SHARE and share - base >= JUMP_MARGIN:
                flagged.append(
                    {
                        "from_bar": fb,
                        "to_bar": tb,
                        "reached": reached,
                        "failed": failed_attempts,
                        "control_error_rate": _r3(base),
                    }
                )
        if flagged:
            out.append(
                _cand(
                    "repeats_not_followed",
                    len(flagged),
                    {"jumps": flagged},
                    score=sid,
                    bars=sorted({f["to_bar"] for f in flagged}),
                )
            )
    return out


def detect(runs: list, attempts: list, reports: list, tree: dict | None, state: dict | None, score_keys: dict) -> list:
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        return _detect(runs, attempts, reports, tree, state, score_keys)
    finally:
        if was_enabled:
            gc.enable()


def _detect(runs, attempts, reports, tree, state, score_keys) -> list:
    runs = [r for r in runs if r.counted]
    attempts = [a for a in attempts if runs_mod.attempt_counted(a)]
    prep = _Prep(runs)
    out = (
        _start_at_bar_1(attempts)
        + _plays_through_mistakes(prep, attempts)
        + _tempo_too_high(runs, tree)
        + _avoids_weak_node(runs, tree, state)
        + _restarts_same_spot(attempts)
        + _rushing(prep, reports)
        + _slows_at_hard_bars(prep)
        + _cuts_long_notes(runs)
        + _left_hand_late(reports)
        + _flat_dynamics([a for a in attempts if not str(a.get("score", {}).get("id", "")).startswith(("sight:", "ear:"))])
        + _same_wrong_pitch(attempts)
        + _key_signature_semitone(attempts, score_keys)
        + _rests_not_counted(prep)
        + _rhythm_consistently_wrong(prep)
        + _repeats_not_followed(prep)
    )
    return sorted(out, key=lambda c: (c["id"], c["where"]["score"] or "", c["where"]["bars"]))
