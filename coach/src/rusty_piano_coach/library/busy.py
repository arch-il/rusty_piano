"""Cross-process lock for a library folder.

coach serve holds it while a job runs and the CLI delete holds it while it removes scores.
The OS releases it when the process ends, so it can never be left stale.
"""

import os
import sys
from pathlib import Path

BUSY_LOCK_NAME = "busy.lock"


class FileLock:
    def __init__(self, path):
        self.path = Path(path)
        self._fd = None

    def acquire(self) -> bool:
        if self._fd is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        try:
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def release(self) -> None:
        fd = self._fd
        if fd is None:
            return
        try:
            if sys.platform == "win32":
                import msvcrt

                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)
        self._fd = None


def busy_lock(data_dir) -> FileLock:
    return FileLock(Path(data_dir) / BUSY_LOCK_NAME)
