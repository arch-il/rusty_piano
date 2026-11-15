# Attempts

This folder holds follower attempts, one JSON file per follower run. The sheet music page sends a run to `coach serve` when it finishes or stops, and the server writes it here as `attempt-YYYYMMDD-HHMMSS-xxxxxx.json` (version 1, with the raw events and the per-step results). The code is in `rusty_piano_coach/attempts.py` and `rusty_piano_coach/attempts_cli.py`.

Read them with:

- `uv run coach attempts list` (newest first; `--limit N`, `--json`)
- `uv run coach attempts show <id>` (an id, a unique prefix, `latest`, or a path to a .json; `--json`, `--all-steps`)
- `uv run coach analyse --attempt <id>`

Everything in this folder except this README is ignored by git (see the root .gitignore), because attempts are personal. Back them up separately if you want to keep them.
