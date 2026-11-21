# Reports

This folder holds one report per analysed session. `rusty_piano_coach/reports.py` writes them and `coach evidence` adds them up (for you or an AI coach). `uv run coach analyse` writes `report-<UTC time>-<input>.json` (version 1, the source of truth: summary, per-note rows, per-bar tempo, offset, velocity and dynamics) plus a `.md` summary next to it.

Everything in this folder except this README is ignored by git (see the root .gitignore), because reports are generated from sessions.
