# Sessions

This folder holds recorded practice sessions (.mid files), one per session. The engine writes them automatically during every live session (`session-YYYYMMDD-HHMMSS.mid`, plus a `.wav` with `--record-wav`). The coach reads them in `rusty_piano_coach/sessions.py`.

Everything in this folder except this README is ignored by git (see the root .gitignore), because recordings are personal and pile up with every practice. Back them up separately if you want to keep them.
