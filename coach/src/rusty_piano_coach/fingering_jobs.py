"""Background fingering for coach serve, separate from jobs.py so long runs never block downloads or removes."""

import collections
import threading
import time
from pathlib import Path

from .library import fingering, scale_fingering, scales


def textbook_scale(row: dict):
    if row["source"] == "scales":
        return scales.BY_KEY.get(row["id"].split(":", 1)[1])
    return None


def generate_for_row(row: dict, path: Path, *, force: bool = False, runner=None) -> dict:
    sc = textbook_scale(row)
    if sc:
        if force or fingering.read_status(path)["status"] != "ready":
            scale_fingering.write_scale_sidecar(sc, path)
        return fingering.read_status(path)
    return fingering.generate(path, runner=runner, force=force)


class FingeringWorker:
    def __init__(self, runner=None):
        self.runner = runner
        self._lock = threading.Lock()
        self._queue = collections.deque()
        self._pending = set()
        self._thread = None

    def request(self, score_path: Path) -> None:
        key = str(Path(score_path).resolve())
        with self._lock:
            if key in self._pending:
                return
            self._pending.add(key)
            self._queue.append(Path(score_path))
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()

    def is_pending(self, score_path: Path) -> bool:
        key = str(Path(score_path).resolve())
        with self._lock:
            return key in self._pending

    def wait_idle(self, timeout: float = 60.0) -> bool:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            with self._lock:
                if not self._pending:
                    return True
            time.sleep(0.02)
        with self._lock:
            return not self._pending

    def _run(self) -> None:
        while True:
            with self._lock:
                if not self._queue:
                    self._thread = None
                    return
                path = self._queue.popleft()
            try:
                fingering.generate(path, runner=self.runner)
            except Exception:
                pass
            finally:
                with self._lock:
                    self._pending.discard(str(path.resolve()))
