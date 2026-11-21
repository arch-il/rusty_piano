# rusty_piano coach

The coach saves follower attempts from the sheet music page, analyses them and recorded sessions against scores, and keeps a practice log. It has a sheet music library (find, download, import and search MusicXML scores), a practice plan with a skill tree and level gates, and a local web page with the score follower, replay, sight-reading, ear training, free play, the skill tree and the log. `coach evidence` adds everything up per drill, piece and bar, so you or an AI assistant can plan the next practice from it.

## Layout

```
coach/
  pyproject.toml
  uv.lock             locked Python dependencies (commit it)
  src/rusty_piano_coach/
    __init__.py       package entry point for the coach
    cli.py            the `coach` command (sub-commands `scores`, `attempts`, `analyse`, `plan`, `evidence`, `sight`, `ear`, `fingering`, `log` and `serve`)
    data_paths.py     data folders (attempts, sessions, reports) under coach/data or RUSTY_PIANO_DATA_DIR
    server.py         local web server for the sheet music page (`coach serve`)
    jobs.py           one-at-a-time background jobs for `coach serve` (source setup steps, downloads)
    library/          sheet music library
      __init__.py     package docstring
      paths.py        data directory and its source/file folders
      index.py        SQLite index with full-text search
      busy.py         busy.lock, the lock shared by `coach serve` jobs and `coach scores delete`
      analyse.py      reads a MusicXML score with music21 (length, key, notes, hands)
      difficulty.py   difficulty on a 1-5 scale
      fetch.py        downloads and checksums
      sources.py      source interface shared by the sources
      local.py        imports your own MusicXML files
      pdmx.py         PDMX dataset (catalogue sync and archive download)
      gen.py          source `gen`: the generated exercises for the skill tree drills
      genx/           exercise generators, one module per track (reading, rhythm, technique, coordination, expression, harmony, pieces) plus seedtree.py
      scales.py       source `scales`: 972 scales and arpeggios in all 12 keys with textbook fingering
      scale_fingering.py  textbook fingering for the scales source
      fingering.py    pianoplayer fingering sidecars for the piano strip
      score_notes.py  hard bars, bar notes and the piece note (`<score>.notes.json`)
      cli.py          `coach scores ...` commands
    attempts.py       validates, saves, lists and loads follower attempts (one JSON file per run)
    attempts_cli.py   `coach attempts list` and `coach attempts show`
    scores.py         placeholder (compare.py builds the expected notes per bar for the analysis)
    sessions.py       loads recorded .mid sessions into timed notes and pedal events, and finds the session that matches an attempt
    compare.py        aligns a session or attempt with its score and finds wrong, missed and extra notes, timing and dynamics problems
    reports.py        writes the JSON and Markdown report for one analysed session
    analyse_cli.py    `coach analyse` (a session or a saved attempt against a score)
    practice_log.py   `coach log`: minutes per day, streak and pieces worked on
    trends.py         evidence for the coach: adds up attempts and reports per drill, piece, bar and feature (`coach evidence`)
    runs.py           turns saved attempts into runs (one per attempt, or per loop cycle)
    habits.py         habit detection across runs, attempts and reports (15 detectors)
    plan.py           the practice plan: tree.json (skills and drills), state.json (levels and habits), today.md (`coach plan`)
    gates.py          level gates per skill: good, solid and mastered, plus lock and rusty flags
    timing.py         graded timing score (0-100), the same curve as the web page
    evenness.py       rhythmic evenness (0-100) of runs on scale scores
    sight.py          sight-reading rounds: speed targets, drill stats and round history
    sight_cli.py      `coach sight add-drills`
    ear.py            ear-training rounds: speed targets, drill stats and round history
    ear_cli.py        `coach ear add-drills`
    replay.py         read-only replay data for the page (recent attempts, one attempt, session recordings)
    fingering_cli.py  `coach fingering`: makes the fingering sidecars for the piano strip
    fingering_jobs.py background fingering for `coach serve`, separate from jobs.py
    attempt_cache.py  cache of parsed attempts for `coach evidence`
    localzone.py      the computer's own time zone, for local dates in the log
    seed/tree.json    the seed skill tree (77 skills in 10 tracks) that `coach plan init` copies
    schemas/          JSON schemas of tree.json and state.json
  tests/              pytest suite (one test_*.py per module or feature), plus helpers:
    conftest.py       shared test setup
    mid_fixtures.py   builds small .mid files for the tests
    fake_pdmx.py      builds fake PDMX data for tests and for trying the page
    fixtures/, analysis_fixtures/   small MusicXML files and analysis inputs
  web/
    package.json
    package-lock.json     locked npm dependencies (commit it)
    tsconfig.json         type-check settings for src, tests and vite.config.ts
    vite.config.ts        dev server (port 5173) and preview (port 4173); proxies /api to coach serve
    index.html            page markup
    src/
      main.ts             wires top bar, library sidebar and score view
      api.ts              talks to coach serve under /api
      attempt-recorder.ts records a follower run and sends it to coach serve when it ends
      library-logic.ts    formatting, messages, list states
      score-geometry.ts   bar rectangles, click hit test, zoom steps
      cursor-steps.ts     playhead step rules (never before the first or past the last note)
      score-view.ts       renders a score with OpenSheetMusicDisplay: zoom, bar selection, playhead
      topbar.ts           title, piece details, zoom, playhead, practice metrics, engine dot
      sidebar.ts          library: search, filters, list
      source-query.ts     minimum search length for source search (same rule as the server)
      styles.css          all styling; colours, fonts and sizes are CSS variables in :root
      feedback-overlay.ts colours played notes over the score (red to green by timing score)
      engine-socket.ts    connects (and reconnects) to the engine's live event WebSocket
      keyboard-notes.ts   dev-only computer-keyboard-to-notes fallback
      follower.ts, live-matcher.ts, note-matcher.ts, hold-checker.ts, timing-score.ts
                          the score follower: wait and live mode, held-note checks, graded timing
      practice-*.ts, tempo-ramp.ts, tempo-map.ts, autoplay.ts
                          practice controls and metrics: hands, loops, tempo ramp, auto-play
      replay-*.ts         replay of a saved run over the score
      sight-*.ts          sight-reading drills (`#/sight`)
      ear-*.ts            ear training (`#/ear`)
      free-play-*.ts      free play: writes down what you play and names the chords (`#/free`)
      skills-*.ts         the skill tree (`#/skills`)
      log-*.ts            the practice log (`#/log`)
      score-notes*.ts     hard bars, bar notes and the piece note
      generated-fingering.ts, fingering-toggle.ts, piano-*.ts, live-keys.ts
                          the piano strip with held keys and fingering
    tests/                node --test unit tests for the TypeScript modules (incl. engine-socket, keyboard-notes, page-wiring, page-layout, source-query, source-search-wiring)
  data/
    attempts/README.md
    scores/README.md
    sessions/README.md
    reports/README.md
    plan/README.md
```

## Quick start with make

From the repo root:

- `make install` installs the coach (uv) and web (npm) dependencies.
- `make engine` runs the engine live (ws port 8790); `make demo` runs it in demo mode.
- `make api` runs the coach API; `make web` runs the Vite page.
- `make dev` runs the engine in this terminal and api and web in the background (logs in `.dev-logs/`), via `scripts/dev.ps1`. The engine builds with ASIO by default and uses `engine/setup.ron`. Ctrl+C stops all three (the engine saves the recording first); Enter stops the engine and then the rest.
- `make dev-here` runs engine, api and web in this terminal with their output mixed (same ASIO default and `engine/setup.ron`). Ctrl+C stops all three (the engine saves the recording first); Enter stops the engine and then the rest.
- `make test` runs the engine, coach and web tests.

## Python (uv)

Run these in `coach/`:

```
uv sync
uv run pytest
```

`uv sync` creates `.venv` and `uv.lock`. Commit `uv.lock`. `uv run pytest` now runs all tests, including the smoke test that checks the package imports.

## Sheet music library

Run these in `coach/`:

```
uv run coach scores sources                      # list the score sources
uv run coach scores sync pdmx                    # load the PDMX catalogue into the index
uv run coach scores sync pdmx --from C:\path\PDMX.csv   # load the catalogue from a local copy
uv run coach scores fetch-archive pdmx           # download the PDMX archive (one time, 1.9 GB)
uv run coach scores sync gen                     # make the generated exercises for the skill tree drills
uv run coach scores sync scales                  # make the scales and arpeggios (all 12 keys)
uv run coach scores search "fur elise" --piano --difficulty 1-2   # piano scores, difficulty 1 or 2
uv run coach scores search --composer bach --max-seconds 120     # Bach, up to 2 minutes
uv run coach scores download 1234 5678           # download scores into your library
uv run coach scores import C:\music\my_scores    # import your own MusicXML files
uv run coach scores list                         # list the scores you have downloaded or imported
uv run coach scores show 1234                    # details, licence and file of one score
uv run coach scores delete 1234 5678             # remove scores from your library (an online score stays searchable; an import's original file is untouched)
uv run coach fingering [--source S | --id ID] [--force]   # pre-generate strip fingering (pianoplayer; textbook for scales), cached next to each score
```

- Ids: the # number, the full id `pdmx:<hash>` or `local:<sha16>`, or a unique prefix of either.
- `sync pdmx` loads the full catalogue (about 254k scores) in about 33 s.
- `fetch-archive` is a one-time 1.9 GB download. It resumes if interrupted and checks the md5. A file that is already there with the right md5 is not downloaded again.
- `download` scans the archive (about 30 s per call), so pass several ids at once.
- Key and time signature are known only after download or import, so `--key` and `--time` only match those scores.
- Difficulty 1-5: for downloaded or imported scores it comes from music21 (notes per second, pitch range, chords, two hands, accidentals), blended 70/30 with the PDMX complexity. For catalogue-only rows it blends the PDMX complexity with notes per second. The constants are in `library/difficulty.py`.
- Licence: PDMX is CC BY 4.0 (Long et al., 2024, https://zenodo.org/records/15571083). Each score stores its own licence and attribution (see `show`). Scores with a licence conflict are hidden unless you pass `--include-conflicts`.
- Data folder: `coach/data/scores/` of whichever checkout runs the command. Use `--data-dir` or the `RUSTY_PIANO_SCORES_DIR` environment variable to put it somewhere else. `--data-dir` can go before or after the sub-command.
- Every command has `--help` descriptions.
- `download` exits with code 1 when some scores could not be downloaded.
- `delete` goes through every id, reports the ones it cannot find or remove, and exits with code 1 if any failed. It refuses to run while `coach serve` runs a download or setup step on the same data folder (they share a lock file, `busy.lock`).

## Attempts, analysis and practice log

Run these in `coach/`:

```
uv run coach attempts list                       # saved follower attempts, newest first (--limit N, --json)
uv run coach attempts show <id>                  # one attempt: an id, a unique prefix, latest or a .json path (--json, --all-steps)
uv run coach analyse <session.mid|latest> --score <id>   # compare a recorded session with a library score and write a report
uv run coach analyse --attempt <id>              # compare a saved attempt with its own score (--score is optional)
uv run coach log [--json]                        # minutes per day, practice streak and pieces worked on
```

- `analyse` also takes `--score-file <file>` (a MusicXML file instead of a library score), `--hands both|right|left`, `--bars A-B` (or one bar), `--from-bar N`, `--loops N`, and `--start-ms`/`--end-ms` for a session .mid. A session needs `--score` or `--score-file`.
- Saved attempts are in `coach/data/attempts/` (written by `coach serve` when a run ends). Reports are in `coach/data/reports/`. The `coach/data` folder moves when `RUSTY_PIANO_DATA_DIR` is set; `--attempts-dir`, `--sessions-dir` and `--reports-dir` override one folder.
- `log` counts the time covered by session .mid files (`coach/data/sessions/`) and saved attempts. Overlapping time counts once and spans are split at midnight. `--days N` sets the window shown (default 14). `--today YYYY-MM-DD` sets today, and `--utc` counts dates in UTC instead of local time. Missing folders count as no practice; `log` never creates them.

## Practice plan and evidence

Run these in `coach/`:

```
uv run coach plan init                          # create tree.json and state.json from the seed (never overwrites)
uv run coach plan check                         # validate tree.json, state.json and today.md
uv run coach plan link <drill-id>               # print a page link that opens a drill (bars, hands, tempo, mode, loop, ramp)
uv run coach plan link --score <id> --bars 5-8 --hands right --tempo 70 --mode wait --loop
uv run coach evidence                           # add up attempts and reports per drill, piece, bar and feature, plus habits
uv run coach evidence --update-state            # also write the gate numbers into state.json
uv run coach sight add-drills                   # append the seed tree's sr.* sight-reading drills to your tree.json
```

- Gates per skill: **good** (3 clean runs on at least 2 days), **solid** (5 clean runs in a 7-day window over 3 days, no open habits) and **mastered** (cold runs after at least 7 days away, on 2 materials). The exact numbers are in `default_gates` of `seed/tree.json`; a mastered skill is flagged rusty after 30 days (`decay_days`) without a clean run.
- `evidence` takes `--since`, `--all` (ignore `last_review`), `--today`, `--utc`, `--json`, `--habit-days N` (default 14) and the folder options of `analyse`.
- The plan files are described in `data/plan/README.md`.

## Ear training

Run this in `coach/`:

```
uv run coach ear add-drills                     # append the ear track (E1-E6) and its ear.* drills to your tree.json; never removes or changes anything
```

Ear training page: open `#/ear` from the Ear button in the top bar of the web page. It has levels E1-E6. The engine plays the questions; when the engine is not running, the page plays them with a tone in the browser instead. You answer on the keyboard. Each finished round is saved as an attempt with the score `ear:<level>`.

## Web page (Vite + TypeScript)

Use two terminals.

```
uv run coach serve                 # in coach/: library API on http://127.0.0.1:8765
npm install                        # in coach/web/: once
npm run dev                        # in coach/web/: open http://localhost:5173
npm run build                      # in coach/web/: tsc type-check of src, tests and vite.config.ts, then Vite build into dist/
node --test tests/*.test.ts        # in coach/web/: unit tests
```

- `npm install` installs the dependencies and creates `package-lock.json`. Commit it, like `uv.lock`.
- `coach serve` uses only the Python standard library and listens on 127.0.0.1 only. It serves GET requests for the library, and accepts guarded POST requests (same-origin, localhost only) to download a score, to remove a score and to run a source setup step, and to save a follower attempt (`/api/attempts`, written to `coach/data/attempts/`). It runs one job at a time and serves only score files the index lists as downloaded or imported. It answers only requests whose Host is localhost, 127.0.0.1 or ::1, and accepts POSTs only from the page on port 5173 (`npm run dev`), 4173 (`npm run preview`) or its own port. `RUSTY_PIANO_ORIGIN_PORTS` (comma separated) adds extra page ports that may POST.
- `npm run dev` always uses port 5173 and stops if that port is taken.
- `tsconfig.json` type-checks `src`, `tests` and `vite.config.ts`, so `npm run build` checks the web tests too; `node --test` runs them.
- Search sources from the page: an empty search box shows your library. Type two or more letters to search your library plus all sources. The setup box shows from two letters, as source search does; a download or setup started in another tab shows up when you switch back. A score you have not downloaded has a download button in its corner; a score in your library has a small ✕ button in the same corner (click it, then click "Delete?" within 3 s to remove it; a score open on the page stays on screen). While you type, sources that need setup show buttons for it: the PDMX catalogue (about 225 MB) and the PDMX archive (about 1.9 GB), with live progress while they run.
- Try it with fake data (no download needed): `uv run python tests/fake_pdmx.py <data dir>`, then `uv run coach serve --data-dir <data dir>`.
- `coach serve` takes `--data-dir` (or the `RUSTY_PIANO_SCORES_DIR` environment variable) and `--port` (default 8765). If you change the port, change the proxy target in `web/vite.config.ts` too.
- Ctrl+C stops `coach serve`.
- API: `GET /api/scores?q=&difficulty=1-2&key=&time=&limit=` returns `{scores, total, facets}`; `GET /api/scores/<id>` returns one score; `GET /api/scores/<id>/file` returns the MusicXML or .mxl file. Ids are URL-encoded (`local:abc` becomes `local%3Aabc`).
- POST: `/api/scores/<id>/download` starts a download; `/api/sources/<name>/setup/<step>` runs a source setup step; `/api/scores/<id>/delete` removes a score from the library (409 while a job runs); `GET /api/jobs/current` returns the running job (or null).
- Score notes: `GET /api/scores/<id>/notes` returns `{version, piece_note, hard_bars, bar_notes, updated_at}` (empty when there are none); a guarded `POST` to the same URL (`Content-Type: application/json`) replaces them. They are saved in `<score file>.notes.json` next to the score; bars count from 1 in score order, like the page bar selection. Bar notes hold up to 500 characters, the piece note up to 2000; saving an empty set removes the file, and deleting the score deletes it too.
- The page: the Library button opens a sidebar over the score with search and difficulty/key/time filters; picking a piece closes it and renders the score with OpenSheetMusicDisplay; the top bar shows title and composer, an i button with the other details, zoom, playhead buttons (also Left/Right arrow keys) and the practice metrics of the current run (accuracy, tempo, wrong, missed, timing); click a bar to select it and move the playhead there; the open piece is kept in the address (`#score=...`), so a reload keeps it. Back/Forward or editing `#score=...` in the address switches the piece. The score renderer (OSMD) loads on first score open.
- Engine connection: the page connects to the engine's live event WebSocket at ws://127.0.0.1:8790. Start the engine in engine/ with `cargo run -- --demo --ws-port 8790`, or set `ws_port: Some(8790)` in engine/setup.ron for live playing. To use another port, add `?engine=<port>` to the page address, e.g. http://localhost:5173/?engine=8791 (invalid values fall back to 8790). The dot at the right end of the top bar is green when connected, amber while connecting and red when disconnected; after the engine stops, the tooltip keeps '(engine stopped)' until it is back. Hovering it shows the state, the address and the last note (e.g. 'C4 vel 64'), and it pulses on each note. The page reconnects by itself (after 1 s, 2 s, 4 s, then every 5 s), so open the page first: `--demo`/`--play` wait only 10 s for it. While the engine is off, the browser console shows a failed-connection error on each retry; that is normal.
- Computer keyboard (only with `npm run dev`, only while the engine is not connected): A W S E D F T G Y H U J K play C4 to C5, Z/X shift an octave down/up (C1 to C7 range), Space is the sustain pedal, and velocity is fixed at 80. It is ignored while typing in the search box or with Ctrl/Alt; the arrow keys and Escape work as before. Each live event is printed to the browser console (console.info, 'live event').
- Restyling: all styles are in `web/src/styles.css`; colours, fonts and sizes are CSS variables in its `:root` block.

## Data

- `data/attempts/`: saved follower attempts (one JSON file per run). Ignored by git except its README.
- `data/scores/`: the sheet music library (index, downloads, imports). Also holds `busy.lock`, a lock file used while a job or delete runs (safe to leave). Ignored by git except its README.
- `data/sessions/`: recorded sessions (.mid). Ignored by git except its README.
- `data/reports/`: one report per analysed session. Ignored by git except its README.
- `data/plan/`: the practice plan (profile, skill tree, progress, journal). Kept in its own git repo (`data/plan/.git`); the main repo tracks only its READMEs. `uv run coach plan init` creates `tree.json` and `state.json` on a fresh checkout.

Git rule: everything under `data/` is ignored by the main repo except the READMEs. `plan/` has its own repo for its history.

## Not built yet

- importing sheet music from a PDF or a photo
- `scores.py` is still a placeholder (`compare.py` builds the expected notes per bar)
