"""One-at-a-time background jobs for coach serve (source setup steps and score downloads)."""

import sqlite3
import tarfile
import threading
from contextlib import contextmanager
from pathlib import Path

from .library.busy import FileLock
from .library.sources import UnsupportedCommand

OTHER_PROCESS_LABEL = "a coach command in another window"


class Busy(Exception):
    def __init__(self, job: dict):
        self.job = job
        super().__init__(f"Another task is running: {job['label']}. Wait for it to finish.")


class Jobs:
    def __init__(self, lock_path=None):
        self._lock = threading.Lock()
        self._job = None
        self._thread = None
        self._count = 0
        self.lock_path = Path(lock_path) if lock_path else None

    def start(self, *, kind: str, source: str, target: str, label: str, work) -> dict:
        with self._lock:
            if self._job is not None and self._job["state"] == "running":
                raise Busy(dict(self._job))
            file_lock = None
            if self.lock_path is not None:
                file_lock = FileLock(self.lock_path)
                if not file_lock.acquire():
                    raise Busy({"label": OTHER_PROCESS_LABEL})
            self._count += 1
            job = {
                "id": self._count,
                "kind": kind,
                "source": source,
                "target": target,
                "label": label,
                "state": "running",
                "phase": "Starting",
                "done": None,
                "total": None,
                "unit": "bytes",
                "message": None,
                "error": None,
            }
            self._job = job
            snapshot = dict(job)

        def progress(phase, done, total, unit="bytes"):
            with self._lock:
                job.update(phase=phase, done=done, total=total, unit=unit)

        self._thread = threading.Thread(target=self._run, args=(job, work, progress, file_lock), daemon=True)
        try:
            self._thread.start()
        except BaseException:
            if file_lock is not None:
                file_lock.release()
            raise
        return snapshot

    @contextmanager
    def idle(self):
        """Run a short synchronous change while no job runs and no other coach process holds busy.lock; raises Busy otherwise."""
        with self._lock:
            if self._job is not None and self._job["state"] == "running":
                raise Busy(dict(self._job))
            file_lock = None
            if self.lock_path is not None:
                file_lock = FileLock(self.lock_path)
                if not file_lock.acquire():
                    raise Busy({"label": OTHER_PROCESS_LABEL})
            try:
                yield
            finally:
                _release(file_lock)

    def _run(self, job, work, progress, file_lock=None):
        try:
            value = work(progress)
        except Exception as e:
            _release(file_lock)
            with self._lock:
                job.update(state="error", error=_error_text(e))
        else:
            _release(file_lock)
            with self._lock:
                job.update(state="done", message=None if value is None else str(value))

    def current(self) -> dict | None:
        with self._lock:
            return dict(self._job) if self._job is not None else None

    def running(self) -> dict | None:
        job = self.current()
        return job if job is not None and job["state"] == "running" else None

    def wait(self, timeout: float = 60.0) -> dict | None:
        with self._lock:
            thread = self._thread
        if thread is not None:
            thread.join(timeout)
        return self.current()


def _release(file_lock) -> None:
    if file_lock is not None:
        try:
            file_lock.release()
        except OSError:
            pass


def _error_text(e: Exception) -> str:
    if isinstance(e, (tarfile.TarError, EOFError)):
        return f"archive is damaged ({e}); fetch it again"
    if isinstance(e, sqlite3.Error):
        return f"library index problem ({e})"
    if isinstance(e, (OSError, LookupError, ValueError, UnsupportedCommand)):
        return str(e) or type(e).__name__
    return f"internal error: {e}"
