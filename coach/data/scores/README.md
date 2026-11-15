# Scores

- This folder is the sheet music library managed by `uv run coach scores ...` (code in `rusty_piano_coach/library/`).
- Layout: library.sqlite (search index), sources/pdmx/PDMX.csv and sources/pdmx/mxl.tar.gz (PDMX catalogue and archive), files/pdmx/ (downloaded scores), files/local/ (your imported files).
- Use `--data-dir` or the RUSTY_PIANO_SCORES_DIR environment variable to put it somewhere else.
- Everything in this folder except this README is ignored by git.
- The archive is about 1.9 GB and the catalogue about 225 MB; back up files/local/ yourself if you care about it.
