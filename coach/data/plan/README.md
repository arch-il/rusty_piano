# Practice plan

This folder holds the practice plan. It is its own git repo (`coach/data/plan/.git`), separate from the main rusty_piano repo, so the plan's history is kept without filling the code history. The main repo tracks only the READMEs here as placeholders and ignores everything else.

Fresh checkout: run `uv run coach plan init` (creates `tree.json` from the seed and an empty `state.json`), then write `profile.md` yourself or let an AI coach write it. To keep history, run `git init` here, or clone your plan repo into this folder.

- `profile.md`: who the player is and what they want.
- `tree.json`: the skill tree definition (nodes, drills, gates). Change it by hand or with an AI coach, then run `uv run coach plan check`.
- `state.json`: progress. The gate numbers are written by `uv run coach evidence --update-state`.
- `habits.md`: habits the coach is tracking.
- `pieces/<score id with ':' replaced by '_'>.md`: one file per piece.
- `today.md`: today's practice plan.
- `journal/YYYY-MM.md`: monthly journal, append-only.

The web page reads `tree.json` and `state.json` through `GET /api/plan`.

`uv run coach plan check` validates the files.

The files are plain JSON and Markdown, meant to be kept up to date by you or by an AI coach such as Claude Code.
