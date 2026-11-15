"""Reads and writes fingering sidecars for scores and runs pianoplayer to make them."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from fractions import Fraction
from pathlib import Path

SIDECAR_SUFFIX = ".fingering.json"
SIDECAR_VERSION = 1
PIANOPLAYER_TIMEOUT_S = 900

_CIRCLED = {chr(0x2460 + i): str(i + 1) for i in range(5)}
_STEPS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def sidecar_path(score_path: Path) -> Path:
    return score_path.with_name(score_path.name + SIDECAR_SUFFIX)


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def read_score_root(path: Path) -> ET.Element:
    path = Path(path)
    if path.suffix.lower() != ".mxl":
        return ET.parse(path).getroot()
    with zipfile.ZipFile(path) as zf:
        names = zf.namelist()
        member = None
        if "META-INF/container.xml" in names:
            container = ET.fromstring(zf.read("META-INF/container.xml"))
            for rf in container.findall(".//{*}rootfile"):
                full = rf.get("full-path")
                if full and full in names:
                    member = full
                    break
        if member is None:
            for n in names:
                if n.startswith("META-INF/"):
                    continue
                if n.lower().endswith((".xml", ".musicxml")):
                    member = n
                    break
        if member is None:
            raise ValueError("no MusicXML found in the .mxl file")
        return ET.fromstring(zf.read(member))


def normalise_finger(text) -> str | None:
    if text is None:
        return None
    text = text.strip()
    if len(text) == 1 and text in _CIRCLED:
        text = _CIRCLED[text]
    return text or None


def _midi(pitch: ET.Element) -> int:
    step = pitch.findtext("step", "C").strip()
    octave = int(pitch.findtext("octave", "4"))
    alter = round(float(pitch.findtext("alter") or 0))
    return 12 * (octave + 1) + _STEPS[step] + alter


def score_notes(root: ET.Element) -> list[dict]:
    if root.tag != "score-partwise":
        raise ValueError("only score-partwise MusicXML is supported")
    found: dict[tuple, dict] = {}
    staff_offset = 0
    for part in root.findall("part"):
        divisions = 1
        part_staves = 1
        for m_index, measure in enumerate(part.findall("measure")):
            pos = Fraction(0)
            last_onset = Fraction(0)
            for el in measure:
                if el.tag == "attributes":
                    d = el.findtext("divisions")
                    if d and int(d) > 0:
                        divisions = int(d)
                    s = el.findtext("staves")
                    if s:
                        part_staves = max(part_staves, int(s))
                elif el.tag == "backup":
                    pos = max(Fraction(0), pos - Fraction(int(el.findtext("duration") or 0), divisions))
                elif el.tag == "forward":
                    pos += Fraction(int(el.findtext("duration") or 0), divisions)
                elif el.tag == "note":
                    chord = el.find("chord") is not None
                    grace = el.find("grace") is not None
                    dur = Fraction(int(el.findtext("duration") or 0), divisions)
                    onset = last_onset if chord else pos
                    if not chord:
                        last_onset = onset
                    if not grace:
                        pos = onset + dur
                    if grace or el.find("cue") is not None or el.find("rest") is not None:
                        continue
                    pitch = el.find("pitch")
                    if pitch is None:
                        continue
                    staff = int(el.findtext("staff") or 1)
                    part_staves = max(part_staves, staff)
                    f = None
                    for fe in el.findall("notations/technical/fingering"):
                        if fe.text and fe.text.strip():
                            f = normalise_finger(fe.text)
                            break
                    item = {
                        "m": m_index,
                        "q": round(float(onset), 4),
                        "s": staff_offset + staff - 1,
                        "p": _midi(pitch),
                        "f": f,
                    }
                    key = (item["m"], item["q"], item["s"], item["p"])
                    kept = found.get(key)
                    if kept is None:
                        found[key] = item
                    elif kept["f"] is None and item["f"] is not None:
                        kept["f"] = item["f"]
        staff_offset += part_staves
    return [found[k] for k in sorted(found)]


def written_fingering(root: ET.Element) -> list[dict]:
    return [n for n in score_notes(root) if n["f"] is not None]


def write_sidecar(
    score_path: Path,
    *,
    source: str,
    tool: str,
    notes: list[dict],
    error: str | None = None,
    sha: str | None = None,
) -> Path:
    obj = {
        "version": SIDECAR_VERSION,
        "score_sha256": sha or file_sha256(score_path),
        "source": source,
        "tool": tool,
        "error": error,
        "notes": notes if error is None else [],
    }
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n"
    target = sidecar_path(score_path)
    try:
        if target.read_text(encoding="utf-8", newline="") == text:
            return target
    except (OSError, ValueError):
        pass
    tmp = target.with_name(target.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    for attempt in range(5):
        try:
            os.replace(tmp, target)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.05)
    return target


def _none_status() -> dict:
    return {"status": "none", "source": None, "notes": [], "error": None}


def read_status(score_path: Path) -> dict:
    try:
        obj = json.loads(sidecar_path(score_path).read_text(encoding="utf-8"))
        if not isinstance(obj, dict) or obj.get("version") != SIDECAR_VERSION:
            return _none_status()
        if obj.get("score_sha256") != file_sha256(score_path):
            return _none_status()
        source = obj.get("source")
        notes = obj.get("notes")
        error = obj.get("error")
        if not isinstance(notes, list) or (error is not None and not isinstance(error, str)):
            return _none_status()
        if error is None:
            return {"status": "ready", "source": source, "notes": notes, "error": None}
        return {"status": "error", "source": source, "notes": [], "error": error}
    except (OSError, ValueError):
        return _none_status()


def pianoplayer_tool() -> str:
    try:
        return "pianoplayer " + importlib.metadata.version("pianoplayer")
    except importlib.metadata.PackageNotFoundError:
        return "pianoplayer"


def _last_line(text: str) -> str:
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def run_pianoplayer(score_path: Path, timeout_s: float = PIANOPLAYER_TIMEOUT_S) -> list[dict]:
    score_path = Path(score_path)
    wanted = score_notes(read_score_root(score_path))
    if any(n["s"] >= 2 for n in wanted):
        raise RuntimeError("fingering is only made for 1-2 staff piano scores")
    keys = {(n["m"], n["q"], n["s"], n["p"]) for n in wanted}
    with tempfile.TemporaryDirectory(prefix="rp-fingering-", ignore_cleanup_errors=True) as tmp:
        tmp_dir = Path(tmp)
        copy = tmp_dir / ("score" + score_path.suffix.lower())
        shutil.copyfile(score_path, copy)
        out = tmp_dir / "out.xml"
        cmd = [
            sys.executable, "-m", "pianoplayer.cli", str(copy),
            "-o", str(out), "-n", "100000", "-z", "--quiet",
        ]
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        creationflags = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0) | getattr(
            subprocess, "CREATE_NO_WINDOW", 0
        )
        try:
            proc = subprocess.run(
                cmd,
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_s,
                creationflags=creationflags,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"pianoplayer took longer than {int(timeout_s)} s")
        if proc.returncode != 0 or not out.exists():
            line = _last_line(proc.stderr) or _last_line(proc.stdout)
            raise RuntimeError(("pianoplayer failed: " + line)[:300])
        found = written_fingering(ET.parse(out).getroot())
    matched = [n for n in found if (n["m"], n["q"], n["s"], n["p"]) in keys]
    if found and not matched:
        raise RuntimeError("fingering did not match the score")
    return matched


def generate(score_path: Path, runner=None, force: bool = False) -> dict:
    runner = runner or run_pianoplayer
    if not force:
        st = read_status(score_path)
        if st["status"] in ("ready", "error"):
            return st
    sha = file_sha256(score_path)
    try:
        notes = runner(score_path)
        write_sidecar(score_path, source="pianoplayer", tool=pianoplayer_tool(), notes=notes, sha=sha)
    except Exception as e:
        write_sidecar(
            score_path,
            source="pianoplayer",
            tool=pianoplayer_tool(),
            notes=[],
            error=(str(e) or type(e).__name__)[:300],
            sha=sha,
        )
    return read_status(score_path)
