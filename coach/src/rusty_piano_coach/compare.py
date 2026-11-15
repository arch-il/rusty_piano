"""Aligns a practice session with its score and finds wrong, missed and extra notes, timing errors, tempo drift and dynamics problems.

The score is loaded with music21 and its repeats are expanded (written bar numbers are kept). The expected notes
(optionally one hand, a bar range, several loops) are aligned with the played notes by a note-level dynamic
programme with free ends, then timing is fitted (start_ms = a + k * score_ms) to get tempo, per-bar speed and drift.
A played note more than TIMING_GATE_MS off the fitted line is never matched in the second pass (it becomes extra), and the fit is trimmed and repeated.
Each matched note gets a graded timing score (0-100, see timing.py) from its offset to the fitted line; bars and the
summary get the mean of their notes' scores.
A short leading group of notes followed by a pause, which pulls the take onto a later pass, is treated as a false start (extra notes).

Differences from the page's play order
music21's expandRepeats() order next to the page's order (from coach/web/tests/score-timeline.test.ts):
- follower_repeats: music21 1 2 1 3 4 5 1 2 1 3 4 5 6; page 1-2 1 3-5 4-5 6. They differ.
- follower_dc_fine: music21 1 2 1 2 3 4 1 2; page 1-2 1-2 3-4 1-2. They are the same.
- follower_ds_coda: music21 1 2 3 4 2 3 5 6; page 1-4 2-3 5-6. They are the same.
"""

import statistics
from dataclasses import dataclass
from pathlib import Path

import music21
from music21 import dynamics, meter, stream, tempo

from rusty_piano_coach.sessions import PlayedNote
from rusty_piano_coach.timing import DEFAULT_CURVE, mean_score, timing_score

MAX_CELLS = 6_000_000
TIMING_GATE_MS = 1500.0
FALSE_START_MAX_NOTES = 4
FALSE_START_PAUSE_MS = 400.0


@dataclass(frozen=True)
class ScoreNote:
    pitch: int
    q: float
    score_ms: float
    bpm: float
    bar: int
    pass_no: int
    loop: int
    beat: float
    part: int
    seq: int
    dynamic: str | None


@dataclass(frozen=True)
class _Raw:
    pitch: int
    q: float
    bar: int
    pass_no: int
    beat: float
    part: int
    k: int
    bpm: float
    dynamic: str | None


@dataclass
class LoadedScore:
    title: str | None
    time_signature: str | None
    score_bpm: float | None
    bars_written: int
    method: str
    warnings: list[str]
    expanded: list[_Raw]
    written: list[_Raw]
    expanded_bars: list[tuple[int, int, float, float]]
    written_bars: list[tuple[int, int, float, float]]


def _last_at(marks: list[tuple[float, object]], q: float, default):
    value = default
    for t, v in marks:
        if t <= q:
            value = v
        else:
            break
    return value


def _extract(s) -> tuple[list[_Raw], list[tuple[int, int, float, float]]]:
    parts = list(s.parts)
    part_measures = [list(p.getElementsByClass(stream.Measure)) for p in parts]
    starts: list[list[float]] = []
    for ms in part_measures:
        acc = 0.0
        row = []
        for m in ms:
            row.append(acc)
            acc += float(m.duration.quarterLength)
        starts.append(row)
    for p in range(1, len(parts)):
        if len(starts[p]) == len(starts[0]):
            starts[p] = starts[0]
    bars: list[tuple[int, int, float, float]] = []
    seen0: dict[int, int] = {}
    for k, m in enumerate(part_measures[0] if parts else []):
        bar = m.editorial.get("written_bar", m.number)
        seen0[bar] = seen0.get(bar, 0) + 1
        bars.append((bar, seen0[bar], starts[0][k], float(m.duration.quarterLength)))
    tempos: list[tuple[float, float]] = []
    dyns: list[tuple[float, str]] = []
    rows = []
    for p, ms in enumerate(part_measures):
        seen: dict[int, int] = {}
        for k, m in enumerate(ms):
            bar = m.editorial.get("written_bar", m.number)
            seen[bar] = seen.get(bar, 0) + 1
            start = starts[p][k]
            for mm in m.recurse().getElementsByClass(tempo.MetronomeMark):
                bpm = mm.getQuarterBPM()
                if bpm is not None:
                    tempos.append((start + float(mm.getOffsetInHierarchy(m)), float(bpm)))
            for d in m.recurse().getElementsByClass(dynamics.Dynamic):
                dyns.append((start + float(d.getOffsetInHierarchy(m)), d.value))
            for el in m.recurse().notes:
                if el.duration.isGrace:
                    continue
                offset = float(el.getOffsetInHierarchy(m))
                subs = list(el.notes) if el.isChord else [el]
                for n in subs:
                    if not hasattr(n, "pitch"):
                        continue
                    tie = n.tie or el.tie
                    if tie is not None and tie.type in ("stop", "continue"):
                        continue
                    rows.append((n.pitch.midi, start + offset, bar, seen[bar], offset, p, k))
    tempos.sort(key=lambda t: t[0])
    dyns.sort(key=lambda t: t[0])
    first_bpm = tempos[0][1] if tempos else 120.0
    raws = [
        _Raw(pitch, q, bar, pass_no, beat, p, k,
             _last_at(tempos, q, first_bpm), _last_at(dyns, q, None))
        for pitch, q, bar, pass_no, beat, p, k in rows
    ]
    return raws, bars


def load_score(path: Path) -> LoadedScore:
    s = music21.converter.parse(str(path))
    for p in s.parts:
        for m in p.getElementsByClass(stream.Measure):
            m.editorial["written_bar"] = m.number
    warnings: list[str] = []
    try:
        ex = s.expandRepeats()
        method = "music21.expandRepeats"
    except Exception as e:
        ex = s
        method = "written-order"
        warnings.append(f"repeats not expanded: {e}")
    written, written_bars = _extract(s)
    expanded, expanded_bars = _extract(ex)
    first_tempo = None
    for p in s.parts:
        for mm in p.recurse().getElementsByClass(tempo.MetronomeMark):
            if mm.getQuarterBPM() is not None:
                cand = (float(mm.getOffsetInHierarchy(s)), float(mm.getQuarterBPM()))
                if first_tempo is None or cand[0] < first_tempo[0]:
                    first_tempo = cand
    ts = next(iter(s.recurse().getElementsByClass(meter.TimeSignature)), None)
    title = s.metadata.title if s.metadata and s.metadata.title else None
    return LoadedScore(
        title=title,
        time_signature=ts.ratioString if ts is not None else None,
        score_bpm=first_tempo[1] if first_tempo else None,
        bars_written=len(list(s.parts[0].getElementsByClass(stream.Measure))) if len(s.parts) else 0,
        method=method,
        warnings=warnings,
        expanded=expanded,
        written=written,
        expanded_bars=expanded_bars,
        written_bars=written_bars,
    )


def expected_notes(
    score: LoadedScore,
    *,
    hands: str = "both",
    bars: tuple[int, int] | None = None,
    loops: int = 1,
    from_bar_to_end: bool = False,
    loop_speeds: list[float] | None = None,
) -> tuple[list[ScoreNote], list[int], str]:
    if hands not in ("right", "left", "both"):
        raise ValueError(f"unknown hands value: {hands}")
    if loops < 1:
        raise ValueError("loops must be at least 1")

    def keep(r: _Raw) -> bool:
        if hands == "right":
            return r.part == 0
        if hands == "left":
            return r.part >= 1
        return True

    if bars is None:
        raws, bar_list, method = score.expanded, score.expanded_bars, score.method
        positions = list(range(len(bar_list)))
    elif from_bar_to_end:
        raws, bar_list, method = score.expanded, score.expanded_bars, score.method
        first = next((i for i, b in enumerate(bar_list) if b[0] >= bars[0]), len(bar_list))
        positions = list(range(first, len(bar_list)))
    else:
        raws, bar_list, method = score.written, score.written_bars, "bar-range"
        positions = [i for i, b in enumerate(bar_list) if bars[0] <= b[0] <= bars[1]]
    ranged = bars is not None and not from_bar_to_end
    seq_of = {k: i for i, k in enumerate(positions)}
    base_start = bar_list[positions[0]][2] if positions else 0.0
    base_len = sum(bar_list[k][3] for k in positions)
    base_bars = [bar_list[k][0] for k in positions]
    base = [r for r in raws if keep(r) and r.k in seq_of]
    notes: list[ScoreNote] = []
    for c in range(loops):
        for r in base:
            notes.append(ScoreNote(
                pitch=r.pitch, q=r.q - base_start + c * base_len, score_ms=0.0, bpm=r.bpm,
                bar=r.bar, pass_no=1 if ranged else r.pass_no,
                loop=c + 1, beat=r.beat, part=r.part, seq=seq_of[r.k] + c * len(positions),
                dynamic=r.dynamic))
    notes.sort(key=lambda n: (n.q, n.pitch, n.part))
    ms_at: dict[float, float] = {}
    prev_q = None
    prev_bpm = 120.0
    prev_loop = 1
    acc = 0.0
    out: list[ScoreNote] = []
    for n in notes:
        if n.q not in ms_at:
            if prev_q is not None:
                speed = 1.0
                if loop_speeds:
                    speed = loop_speeds[min(prev_loop, len(loop_speeds)) - 1]
                acc += (n.q - prev_q) * 60000 / prev_bpm / speed
            ms_at[n.q] = acc
            prev_q = n.q
            prev_bpm = n.bpm
            prev_loop = n.loop
        out.append(ScoreNote(n.pitch, n.q, ms_at[n.q], n.bpm, n.bar, n.pass_no, n.loop,
                             n.beat, n.part, n.seq, n.dynamic))
    return out, base_bars * loops, method


def _cluster(played: list[PlayedNote], chord_ms: float) -> list[PlayedNote]:
    ordered = sorted(played, key=lambda p: p.start_ms)
    result: list[PlayedNote] = []
    group: list[PlayedNote] = []
    for p in ordered:
        if group and p.start_ms - group[0].start_ms > chord_ms:
            result.extend(sorted(group, key=lambda g: (g.pitch, g.start_ms)))
            group = []
        group.append(p)
    result.extend(sorted(group, key=lambda g: (g.pitch, g.start_ms)))
    return result


def _dp(S, P, free_ends: bool, fit: tuple[float, float] | None) -> list[dict]:
    n, m = len(S), len(P)
    width = m + 1
    back = bytearray((n + 1) * width)
    prev = [float(j) for j in range(m + 1)]
    for j in range(1, m + 1):
        back[j] = 3
    last = [prev[m]]
    for i in range(1, n + 1):
        cur = [0.0] * (m + 1)
        cur[0] = 0.0 if free_ends else float(i)
        si = S[i - 1]
        base = i * width
        for j in range(1, m + 1):
            pj = P[j - 1]
            cost = 0.0 if pj.pitch == si.pitch else 1.0
            if fit is not None:
                err = abs(pj.start_ms - (fit[0] + fit[1] * si.score_ms))
                if err > TIMING_GATE_MS:
                    cost = 2.5
                else:
                    cost += 0.4 * min(1.0, err / 2000.0)
            best = prev[j - 1] + cost
            ptr = 1
            v = prev[j] + 1
            if v < best:
                best, ptr = v, 2
            v = cur[j - 1] + 1
            if v < best:
                best, ptr = v, 3
            cur[j] = best
            back[base + j] = ptr
        last.append(cur[m])
        prev = cur
    if free_ends:
        end_i = min(range(n + 1), key=lambda i: (last[i], i))
    else:
        end_i = n
    items: list[dict] = []
    i, j = end_i, m
    while j > 0:
        ptr = back[i * width + j]
        if ptr == 1:
            kind = "match" if S[i - 1].pitch == P[j - 1].pitch else "wrong"
            items.append({"kind": kind, "score": S[i - 1], "played": P[j - 1]})
            i, j = i - 1, j - 1
        elif ptr == 2:
            items.append({"kind": "missed", "score": S[i - 1], "played": None})
            i -= 1
        else:
            items.append({"kind": "extra", "score": None, "played": P[j - 1]})
            j -= 1
    lead = "not_reached" if free_ends else "missed"
    while i > 0:
        items.append({"kind": lead, "score": S[i - 1], "played": None})
        i -= 1
    items.reverse()
    for s in S[end_i:]:
        items.append({"kind": "not_reached", "score": s, "played": None})
    return items


def _fit(items: list[dict]) -> tuple[float, float] | None:
    ms = [it for it in items if it["kind"] == "match"]
    xs = [it["score"].score_ms for it in ms]
    if len(set(xs)) < 2:
        return None
    ys = [it["played"].start_ms for it in ms]
    k, a = statistics.linear_regression(xs, ys)
    for _ in range(5):
        keep = [i for i in range(len(xs)) if abs(ys[i] - (a + k * xs[i])) <= TIMING_GATE_MS]
        if len(keep) == len(xs) or len({xs[i] for i in keep}) < 2:
            break
        xs = [xs[i] for i in keep]
        ys = [ys[i] for i in keep]
        k, a = statistics.linear_regression(xs, ys)
    return a, k


def _without_false_start(expected, played, items, chord_ms):
    fit = _fit(items)
    if fit is None:
        return items
    k = fit[1]
    hits = [it for it in items if it['kind'] in ('match', 'wrong')]
    cut = None
    for j in range(1, min(FALSE_START_MAX_NOTES, len(hits) - 1) + 1):
        prev, cur = hits[j - 1], hits[j]
        played_gap = cur['played'].start_ms - prev['played'].start_ms
        expected_gap = k * (cur['score'].score_ms - prev['score'].score_ms)
        if played_gap - expected_gap >= FALSE_START_PAUSE_MS:
            cut = j
            break
    if cut is None or len(hits) - cut < max(4, 2 * cut):
        return items
    first = hits[cut]
    body_start = first['played'].start_ms - chord_ms
    body = [p for p in played if p.start_ms >= body_start]
    dropped = sorted((p for p in played if p.start_ms < body_start), key=lambda p: p.start_ms)
    new_items = align(expected, body, chord_ms=chord_ms, free_ends=True, _drop_false_start=False)
    new_hits = [it for it in new_items if it['kind'] in ('match', 'wrong')]
    if not new_hits or new_hits[0]['score'].seq >= first['score'].seq:
        return items
    jumped = first['score'].seq - hits[cut - 1]['score'].seq > 1
    earlier_pass = new_hits[0]['score'].pass_no < first['score'].pass_no
    if not (jumped or earlier_pass):
        return items
    return [{'kind': 'extra', 'score': None, 'played': p} for p in dropped] + new_items


def align(expected, played, *, chord_ms: float = 40.0, free_ends: bool = True, _drop_false_start: bool = True) -> list[dict]:
    items = _align_plain(expected, played, chord_ms=chord_ms, free_ends=free_ends)
    if _drop_false_start and free_ends:
        return _without_false_start(expected, played, items, chord_ms)
    return items


def _align_plain(expected, played, *, chord_ms, free_ends):
    S = list(expected)
    P = _cluster(list(played), chord_ms)
    n, m = len(S), len(P)
    if n * m > MAX_CELLS:
        raise ValueError(f"too many notes to align ({n} score x {m} played); use --bars or --start-ms/--end-ms")
    items = _dp(S, P, free_ends, None)
    fit = _fit(items)
    if fit is None:
        return items
    items = _dp(S, P, free_ends, fit)
    for _ in range(2):
        new_fit = _fit(items)
        if new_fit is None or (abs(new_fit[0] - fit[0]) <= 50.0 and abs(new_fit[1] - fit[1]) <= 0.01 * abs(fit[1])):
            break
        fit = new_fit
        items = _dp(S, P, free_ends, fit)
    return items


def _r(v, digits):
    return None if v is None else round(v, digits)


def _half_bpm(matches: list[dict], start_bpm: float) -> float | None:
    f = _fit(matches)
    if f is None or f[1] <= 0:
        return None
    return start_bpm / f[1]


KINDS = ("match", "wrong", "missed", "extra", "not_reached")


def analyse(expected, played, *, chord_ms=40.0, tempo_tolerance=0.08, free_ends=True, timing_curve=None) -> dict:
    curve = dict(timing_curve or DEFAULT_CURVE)
    items = align(expected, played, chord_ms=chord_ms, free_ends=free_ends)
    warnings: list[str] = []
    fit = _fit(items)
    start_bpm = expected[0].bpm if expected else None
    a = k = speed = bpm = None
    if fit is None:
        warnings.append("not enough matched notes to measure tempo")
    else:
        a, k = fit
        if k > 0:
            speed = 1 / k
            bpm = start_bpm * speed

    for idx, it in enumerate(items):
        if fit is None or it["kind"] not in ("match", "wrong"):
            it["offset"] = None
        else:
            it["offset"] = it["played"].start_ms - (a + k * it["score"].score_ms)
        it["timing_score"] = timing_score(it["offset"], curve) if it["kind"] == "match" else None
        if it["kind"] == "extra":
            ref = None
            for jdx in range(idx - 1, -1, -1):
                if items[jdx]["score"] is not None:
                    ref = items[jdx]["score"]
                    break
            if ref is None:
                for jdx in range(idx + 1, len(items)):
                    if items[jdx]["score"] is not None:
                        ref = items[jdx]["score"]
                        break
            it["ref"] = ref
        else:
            it["ref"] = it["score"]

    notes_rows = []
    for it in items:
        sc, pl, ref = it["score"], it["played"], it["ref"]
        notes_rows.append({
            "kind": it["kind"],
            "seq": ref.seq if ref else None,
            "bar": ref.bar if ref else None,
            "pass": ref.pass_no if ref else None,
            "loop": ref.loop if ref else None,
            "beat": _r(sc.beat, 3) if sc else None,
            "part": sc.part if sc else None,
            "score_q": _r(sc.q, 3) if sc else None,
            "expected": sc.pitch if sc else None,
            "played": pl.pitch if pl else None,
            "start_ms": _r(pl.start_ms, 1) if pl else None,
            "end_ms": _r(pl.end_ms, 1) if pl else None,
            "velocity": pl.velocity if pl else None,
            "offset_ms": _r(it["offset"], 1),
            "timing_score": it["timing_score"],
        })

    seqs = sorted({n.seq for n in expected})
    by_seq_notes = {s: [n for n in expected if n.seq == s] for s in seqs}
    by_seq_items = {s: [it for it in items if it["ref"] is not None and it["ref"].seq == s] for s in seqs}
    firsts: dict[int, dict] = {}
    for s in seqs:
        ms = [it for it in by_seq_items[s] if it["kind"] == "match"]
        if ms:
            firsts[s] = min(ms, key=lambda it: it["score"].q)
    with_matches = sorted(firsts)
    bars_out = []
    for s in seqs:
        sn = by_seq_notes[s]
        first_note = min(sn, key=lambda n: (n.q, n.pitch, n.part))
        bar_speed = None
        if s in firsts:
            f = firsts[s]
            later = [t for t in with_matches if t > s]
            if later:
                g = firsts[later[0]]
            else:
                ms = [it for it in by_seq_items[s] if it["kind"] == "match"]
                g = max(ms, key=lambda it: it["score"].q)
            ds = g["score"].score_ms - f["score"].score_ms
            dp = g["played"].start_ms - f["played"].start_ms
            if ds > 0 and dp > 0:
                bar_speed = ds / dp
        bar_bpm = first_note.bpm * bar_speed if bar_speed is not None else None
        if bar_speed is None or speed is None:
            flag = None
        elif bar_speed > speed * (1 + tempo_tolerance):
            flag = "rushed"
        elif bar_speed < speed * (1 - tempo_tolerance):
            flag = "dragged"
        else:
            flag = "steady"
        its = by_seq_items[s]
        counts = {kind: sum(1 for it in its if it["kind"] == kind) for kind in KINDS}
        timed = [it for it in its if it["kind"] in ("match", "wrong")]
        offs = [it["offset"] for it in timed if it["offset"] is not None]
        vels = [it["played"].velocity for it in timed]
        bars_out.append({
            "seq": s, "bar": first_note.bar, "pass": first_note.pass_no, "loop": first_note.loop,
            "notes": len(sn),
            "matched": counts["match"], "wrong": counts["wrong"], "missed": counts["missed"],
            "extra": counts["extra"], "not_reached": counts["not_reached"],
            "mean_offset_ms": _r(statistics.fmean(offs), 1) if offs else None,
            "mean_abs_offset_ms": _r(statistics.fmean(abs(o) for o in offs), 1) if offs else None,
            "timing_score": mean_score(it["timing_score"] for it in its),
            "bpm": _r(bar_bpm, 1), "speed": _r(bar_speed, 3), "tempo": flag,
            "velocity_mean": _r(statistics.fmean(vels), 1) if vels else None,
            "velocity_min": min(vels) if vels else None,
            "velocity_max": max(vels) if vels else None,
            "dynamic": first_note.dynamic,
            "_bpm": bar_bpm,
            "_speed": bar_speed,
        })

    drift = None
    pts = [(b["seq"], start_bpm * b["_speed"]) for b in bars_out if b["_speed"] is not None] if start_bpm else []
    if len(pts) >= 2:
        drift = statistics.linear_regression([p[0] for p in pts], [p[1] for p in pts])[0]
    per_bar = [b["bpm"] for b in bars_out]
    for b in bars_out:
        del b["_bpm"]
        del b["_speed"]
    written_tempos: list[float] = []
    for n in expected:
        t = round(n.bpm, 1)
        if t not in written_tempos:
            written_tempos.append(t)

    matches = sorted((it for it in items if it["kind"] == "match"),
                     key=lambda it: (it["score"].q, it["score"].score_ms))
    half = len(matches) // 2
    first_half = _half_bpm(matches[:half], start_bpm) if start_bpm else None
    second_half = _half_bpm(matches[half:], start_bpm) if start_bpm else None

    rushed: list[int] = []
    dragged: list[int] = []
    for b in bars_out:
        target = rushed if b["tempo"] == "rushed" else dragged if b["tempo"] == "dragged" else None
        if target is not None and b["bar"] not in target:
            target.append(b["bar"])

    counts = {kind: sum(1 for it in items if it["kind"] == kind) for kind in KINDS}
    denom = counts["match"] + counts["wrong"] + counts["missed"]
    timed_all = [it for it in items if it["kind"] in ("match", "wrong")]
    offs_all = [it["offset"] for it in timed_all if it["offset"] is not None]
    vels_all = [it["played"].velocity for it in timed_all]
    onsets = [p.start_ms for p in played]
    summary = {
        "score_notes": len(expected),
        "played_notes": len(played),
        "matched": counts["match"], "wrong": counts["wrong"], "missed": counts["missed"],
        "extra": counts["extra"], "not_reached": counts["not_reached"],
        "accuracy": round(counts["match"] / denom, 3) if denom else None,
        "bpm": _r(bpm, 1), "speed": _r(speed, 3),
        "mean_abs_offset_ms": _r(statistics.fmean(abs(o) for o in offs_all), 1) if offs_all else None,
        "timing_score": mean_score(it["timing_score"] for it in items),
        "drift_bpm_per_bar": _r(drift, 2),
        "written_tempos": written_tempos,
        "first_half_bpm": _r(first_half, 1), "second_half_bpm": _r(second_half, 1),
        "rushed_bars": rushed, "dragged_bars": dragged,
        "velocity_mean": _r(statistics.fmean(vels_all), 1) if vels_all else None,
        "duration_ms": _r(max(onsets) - min(onsets), 1) if len(onsets) >= 2 else None,
    }
    tempo_out = {
        "bpm": _r(bpm, 1), "speed": _r(speed, 3),
        "fit_intercept_ms": _r(a, 1), "fit_ms_per_score_ms": _r(k, 4),
        "per_bar_bpm": per_bar,
        "written_tempos": written_tempos,
        "drift_bpm_per_bar": summary["drift_bpm_per_bar"],
        "first_half_bpm": summary["first_half_bpm"], "second_half_bpm": summary["second_half_bpm"],
    }
    timing_out = {"curve": curve, "timing_score": summary["timing_score"]}
    return {"summary": summary, "notes": notes_rows, "bars": bars_out, "tempo": tempo_out, "timing": timing_out,
            "warnings": warnings}
