import re
import sqlite3
from pathlib import Path

CATALOGUE_FIELDS = [
    "source", "title", "composer", "artist", "tags", "genres", "seconds", "n_notes",
    "notes_per_bar", "n_tracks", "piano_only", "source_complexity", "rating", "n_ratings",
    "n_views", "license", "license_url", "license_conflict", "attribution", "source_ref",
    "difficulty", "difficulty_basis",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS scores (num INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, title TEXT, composer TEXT, artist TEXT, tags TEXT, genres TEXT, seconds REAL, n_notes INTEGER, notes_per_bar REAL, n_tracks INTEGER, piano_only INTEGER, source_complexity INTEGER, rating REAL, n_ratings INTEGER, n_views INTEGER, license TEXT, license_url TEXT, license_conflict INTEGER NOT NULL DEFAULT 0, attribution TEXT, source_ref TEXT, difficulty INTEGER, difficulty_basis TEXT, file_path TEXT, key TEXT, time_signature TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now')), downloaded_at TEXT);
CREATE INDEX IF NOT EXISTS scores_source ON scores(source);
CREATE INDEX IF NOT EXISTS scores_difficulty ON scores(difficulty);
CREATE VIRTUAL TABLE IF NOT EXISTS scores_fts USING fts5(title, composer, artist, tags, genres, content='scores', content_rowid='num', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS scores_ai AFTER INSERT ON scores BEGIN INSERT INTO scores_fts(rowid, title, composer, artist, tags, genres) VALUES (new.num, new.title, new.composer, new.artist, new.tags, new.genres); END;
CREATE TRIGGER IF NOT EXISTS scores_ad AFTER DELETE ON scores BEGIN INSERT INTO scores_fts(scores_fts, rowid, title, composer, artist, tags, genres) VALUES ('delete', old.num, old.title, old.composer, old.artist, old.tags, old.genres); END;
CREATE TRIGGER IF NOT EXISTS scores_au AFTER UPDATE OF title, composer, artist, tags, genres ON scores WHEN old.title IS NOT new.title OR old.composer IS NOT new.composer OR old.artist IS NOT new.artist OR old.tags IS NOT new.tags OR old.genres IS NOT new.genres BEGIN INSERT INTO scores_fts(scores_fts, rowid, title, composer, artist, tags, genres) VALUES ('delete', old.num, old.title, old.composer, old.artist, old.tags, old.genres); INSERT INTO scores_fts(rowid, title, composer, artist, tags, genres) VALUES (new.num, new.title, new.composer, new.artist, new.tags, new.genres); END;
"""

_KEEP_ON_CONFLICT = ("difficulty", "difficulty_basis")

_UPSERT_COLUMNS = ["id"] + CATALOGUE_FIELDS
_UPSERT_SQL = (
    f"INSERT INTO scores ({', '.join(_UPSERT_COLUMNS)}) "
    f"VALUES ({', '.join(':' + c for c in _UPSERT_COLUMNS)}) "
    "ON CONFLICT(id) DO UPDATE SET "
    + ", ".join(f"{f}=excluded.{f}" for f in CATALOGUE_FIELDS if f not in _KEEP_ON_CONFLICT)
    + ", difficulty = CASE WHEN scores.difficulty_basis='score' THEN scores.difficulty ELSE excluded.difficulty END"
    + ", difficulty_basis = CASE WHEN scores.difficulty_basis='score' THEN 'score' ELSE excluded.difficulty_basis END"
)


def fts_query(text: str) -> str:
    tokens = re.findall(r"\w+", text)
    return " ".join(f'"{t}"*' for t in tokens)


def _like_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _upsert_params(record: dict) -> dict:
    params = {f: record.get(f) for f in CATALOGUE_FIELDS}
    params["id"] = record["id"]
    if params["license_conflict"] is None:
        params["license_conflict"] = 0
    return params


class Library:
    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.data_dir / "library.sqlite", timeout=10)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        # The CREATE ... IF NOT EXISTS statements only read when the objects already exist,
        # so opening an existing library does not take the write lock.
        self.conn.executescript(SCHEMA)
        if self.conn.execute("PRAGMA user_version").fetchone()[0] != 1:
            self.conn.execute("PRAGMA user_version = 1")

    def close(self):
        self.conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def upsert_catalogue(self, records, batch_size=5000, progress=None) -> int:
        total = 0
        batch = []
        for record in records:
            batch.append(_upsert_params(record))
            if len(batch) >= batch_size:
                self.conn.executemany(_UPSERT_SQL, batch)
                total += len(batch)
                batch = []
                if progress:
                    progress(total)
        if batch:
            self.conn.executemany(_UPSERT_SQL, batch)
            total += len(batch)
            if progress:
                progress(total)
        self.conn.commit()
        return total

    def update_analysis(self, score_id, *, file_path, key=None, time_signature=None, seconds=None,
                        n_notes=None, piano_only=None, difficulty=None) -> None:
        piano = None if piano_only is None else int(bool(piano_only))
        cur = self.conn.execute(
            "UPDATE scores SET file_path=?, key=?, time_signature=?, "
            "seconds=COALESCE(seconds, ?), n_notes=COALESCE(n_notes, ?), piano_only=COALESCE(piano_only, ?), "
            "difficulty=COALESCE(?, difficulty), "
            "difficulty_basis=CASE WHEN ? IS NULL THEN difficulty_basis ELSE 'score' END, "
            "downloaded_at=datetime('now') WHERE id=?",
            (file_path, key, time_signature, seconds, n_notes, piano, difficulty, difficulty, score_id),
        )
        self.conn.commit()
        if cur.rowcount == 0:
            raise LookupError(f"no score with id '{score_id}'")

    def remove_score(self, score_id) -> None:
        cur = self.conn.execute("DELETE FROM scores WHERE id=?", (score_id,))
        self.conn.commit()
        if cur.rowcount == 0:
            raise LookupError(f"no score with id '{score_id}'")

    def clear_download(self, score_id, *, difficulty) -> None:
        cur = self.conn.execute(
            "UPDATE scores SET file_path=NULL, key=NULL, time_signature=NULL, downloaded_at=NULL, "
            "difficulty=?, difficulty_basis=CASE WHEN ? IS NULL THEN NULL ELSE 'catalogue' END WHERE id=?",
            (difficulty, difficulty, score_id),
        )
        self.conn.commit()
        if cur.rowcount == 0:
            raise LookupError(f"no score with id '{score_id}'")

    def get(self, score_id):
        row = self.conn.execute("SELECT * FROM scores WHERE id=?", (score_id,)).fetchone()
        return dict(row) if row else None

    def resolve(self, text: str) -> dict:
        t = text.strip().lstrip("#").strip()
        if t.isdigit():
            row = self.conn.execute("SELECT * FROM scores WHERE num=?", (int(t),)).fetchone()
            if row:
                return dict(row)
        else:
            row = self.conn.execute("SELECT * FROM scores WHERE id=?", (t,)).fetchone()
            if row:
                return dict(row)
            if ":" in t and len(t.split(":", 1)[1]) >= 4:
                rows = self.conn.execute(
                    "SELECT * FROM scores WHERE id LIKE ? ESCAPE '\\'", (_like_escape(t) + "%",)
                ).fetchall()
                if len(rows) == 1:
                    return dict(rows[0])
                if len(rows) > 1:
                    raise LookupError(f"'{text}' matches {len(rows)} scores; give more characters")
            if ":" in t and len(t.split(":", 1)[1]) < 4:
                raise LookupError(f"'{text}' is too short; give at least 4 characters after the colon, or use the # number")
        raise LookupError(f"no score matches '{text}'")

    def count(self, source=None) -> int:
        if source is None:
            return self.conn.execute("SELECT COUNT(*) FROM scores").fetchone()[0]
        return self.conn.execute("SELECT COUNT(*) FROM scores WHERE source=?", (source,)).fetchone()[0]

    def search(self, text=None, *, composer=None, difficulty=None, key=None, time_signature=None,
               max_seconds=None, piano=False, downloaded=False, source=None, include_conflicts=False,
               order="relevance", limit=20, undownloaded=False) -> list[dict]:
        if text is not None and text.strip() and fts_query(text) == "":
            return []
        q = fts_query(text) if text else ""
        sql = "SELECT s.* FROM scores s"
        where = []
        params = []
        if q:
            sql += " JOIN scores_fts ON scores_fts.rowid = s.num"
            where.append("scores_fts MATCH ?")
            params.append(q)
        if composer:
            where.append("(s.composer LIKE ? ESCAPE '\\' OR s.artist LIKE ? ESCAPE '\\')")
            params += [f"%{_like_escape(composer)}%", f"%{_like_escape(composer)}%"]
        if difficulty is not None:
            where.append("s.difficulty BETWEEN ? AND ?")
            params += [difficulty[0], difficulty[1]]
        if key:
            where.append("(lower(s.key) = lower(?) OR lower(s.key) LIKE lower(?) ESCAPE '\\')")
            params += [key, _like_escape(key) + " %"]
        if time_signature:
            where.append("s.time_signature = ?")
            params.append(time_signature)
        if max_seconds is not None:
            where.append("s.seconds <= ?")
            params.append(max_seconds)
        if piano:
            where.append("s.piano_only = 1")
        if downloaded:
            where.append("s.file_path IS NOT NULL")
        if undownloaded:
            where.append("s.file_path IS NULL")
        if source:
            where.append("s.source = ?")
            params.append(source)
        if not include_conflicts:
            where.append("s.license_conflict = 0")
        if where:
            sql += " WHERE " + " AND ".join(where)
        if order == "title":
            sql += " ORDER BY s.title COLLATE NOCASE, s.num"
        elif q:
            sql += " ORDER BY bm25(scores_fts), COALESCE(s.rating,0) DESC, COALESCE(s.n_views,0) DESC, s.num"
        else:
            sql += " ORDER BY COALESCE(s.rating,0) DESC, COALESCE(s.n_views,0) DESC, s.num"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return [dict(r) for r in self.conn.execute(sql, params).fetchall()]
