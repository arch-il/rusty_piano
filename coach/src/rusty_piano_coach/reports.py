"""Builds and writes the version 1 practice report (JSON, the source of truth, plus a short Markdown summary) into coach/data/reports/."""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

REPORT_VERSION = 1
REPORT_KIND = "rusty_piano.report"
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
LIST_LIMIT = 20


def note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def report_id(stem: str, now: datetime | None = None) -> str:
    if now is None:
        now = datetime.now(timezone.utc)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-")[:60] or "input"
    return f"report-{now:%Y%m%d-%H%M%S}-{safe}"


def build_report(
    analysis: dict,
    *,
    input_info: dict,
    score_info: dict,
    options: dict,
    expansion: dict,
    attempt_summary: dict | None = None,
    attempt_timing: dict | None = None,
    extra_warnings: list[str] = (),
    stem: str,
    now: datetime | None = None,
) -> dict:
    if now is None:
        now = datetime.now(timezone.utc)
    created = now.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "version": REPORT_VERSION,
        "kind": REPORT_KIND,
        "id": report_id(stem, now),
        "created_at": created,
        "input": input_info,
        "score": score_info,
        "options": options,
        "expansion": expansion,
        "summary": analysis["summary"],
        "notes": analysis["notes"],
        "bars": analysis["bars"],
        "tempo": analysis["tempo"],
        "timing": {**analysis.get("timing", {"curve": None, "timing_score": None}), "follower": attempt_timing},
        "attempt_summary": attempt_summary,
        "warnings": list(analysis["warnings"]) + list(extra_warnings),
    }


def _write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_report(report: dict, reports_dir: Path) -> tuple[Path, Path]:
    folder = Path(reports_dir)
    folder.mkdir(parents=True, exist_ok=True)
    base = report["id"]
    name = base
    n = 2
    while (folder / f"{name}.json").exists():
        name = f"{base}-{n}"
        n += 1
    report["id"] = name
    json_path = folder / f"{name}.json"
    md_path = folder / f"{name}.md"
    _write_atomic(json_path, json.dumps(report, ensure_ascii=False, indent=2))
    _write_atomic(md_path, markdown_summary(report))
    return json_path, md_path


def _input_label(report: dict) -> str:
    info = report["input"]
    if info["kind"] == "midi":
        return Path(info["midi_path"]).name if info.get("midi_path") else "session"
    if info["kind"] == "attempt":
        name = Path(info["midi_path"]).name if info.get("midi_path") else "?"
        return f"{info['attempt_id']} (session {name})"
    return f"{info['attempt_id']} (its own events)"


def headline_lines(report: dict) -> list[str]:
    s = report["summary"]
    score = report["score"]
    title = score.get("title") or (Path(score["file"]).name if score.get("file") else "the score")
    lines = [f"Analysed {_input_label(report)} against {title}"]
    acc = s.get("accuracy")
    pct = round(acc * 100) if acc is not None else "-"
    lines.append(
        f"Notes: {s['matched']} matched, {s['wrong']} wrong, {s['missed']} missed, {s['extra']} extra"
        f" (accuracy {pct}%); {s['not_reached']} not reached"
    )
    bpm = s.get("bpm")
    if bpm is None:
        lines.append("Tempo: - (not enough matched notes)")
    else:
        speed = s.get("speed")
        speed_pct = round(speed * 100) if speed is not None else "-"
        score_bpm = score.get("score_bpm")
        marked = f"the marked {score_bpm:g} bpm" if score_bpm is not None else "the score"
        written = s.get("written_tempos") or []
        if len(written) > 1:
            lines.append("Tempo: " + str(speed_pct) + "% of the written tempo ("
                         + " then ".join(f"{b:g}" for b in written) + " bpm)")
        else:
            lines.append(f"Tempo: {bpm} bpm ({speed_pct}% of {marked})")
    ts = s.get("timing_score")
    timing_line = f"Timing score: {ts} of 100" if ts is not None else "Timing score: - (no matched notes)"
    follower = (report.get("timing") or {}).get("follower")
    if follower and follower.get("timing_score") is not None:
        timing_line += f" (follower: {follower['timing_score']} over {follower['scored_steps']} steps)"
    lines.append(timing_line)
    drift = s.get("drift_bpm_per_bar")
    if drift is not None:
        lines.append(f"Drift: {drift:+.1f} bpm per bar")
    if s.get("rushed_bars"):
        lines.append("Rushed bars: " + ", ".join(str(b) for b in s["rushed_bars"]))
    if s.get("dragged_bars"):
        lines.append("Dragged bars: " + ", ".join(str(b) for b in s["dragged_bars"]))
    lines += [f"Warning: {w}" for w in report["warnings"]]
    return lines


def _cell(value) -> str:
    return "-" if value is None else str(value)


def _note_list(report: dict, kind: str) -> list[str]:
    rows = [n for n in report["notes"] if n["kind"] == kind]
    out = []
    for n in rows[:LIST_LIMIT]:
        expected = note_name(n["expected"]) if n["expected"] is not None else "-"
        if kind == "wrong":
            played = note_name(n["played"]) if n["played"] is not None else "-"
            out.append(f"- bar {_cell(n['bar'])} beat {_cell(n['beat'])}: expected {expected}, played {played}")
        else:
            out.append(f"- bar {_cell(n['bar'])} beat {_cell(n['beat'])}: expected {expected}")
    if len(rows) > LIST_LIMIT:
        out.append(f"- ... {len(rows) - LIST_LIMIT} more (see the JSON)")
    return out


def markdown_summary(report: dict) -> str:
    score = report["score"]
    title = score.get("title") or (Path(score["file"]).name if score.get("file") else "score")
    lines = [f"# Practice report: {title}", ""]
    lines.append(f"- Input: {_input_label(report)}")
    lines.append(f"- Created: {report['created_at']}")
    lines += [f"- {line}" for line in headline_lines(report)[1:] if not line.startswith("Warning: ")]
    lines += ["", "## Bars", ""]
    lines.append("| Bar | Pass | Loop | Notes | OK | Wrong | Missed | Extra | bpm | Tempo | Offset ms | Timing | Velocity | Dynamic |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for b in report["bars"]:
        cells = [
            b["bar"], b["pass"], b["loop"], b["notes"], b["matched"], b["wrong"], b["missed"], b["extra"],
            b["bpm"], b["tempo"], b["mean_offset_ms"], b.get("timing_score"), b["velocity_mean"], b["dynamic"],
        ]
        lines.append("| " + " | ".join(_cell(c) for c in cells) + " |")
    lines += ["", "## Wrong notes", ""]
    lines += _note_list(report, "wrong") or ["- none"]
    lines += ["", "## Missed notes", ""]
    lines += _note_list(report, "missed") or ["- none"]
    if report["warnings"]:
        lines += ["", "## Warnings", ""]
        lines += [f"- {w}" for w in report["warnings"]]
    return "\n".join(lines) + "\n"
