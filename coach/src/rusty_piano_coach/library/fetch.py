import hashlib
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


class ChecksumError(ValueError):
    pass


def open_url(url: str, headers: dict[str, str] | None = None):
    req = urllib.request.Request(url, headers={'User-Agent': 'rusty-piano-coach', **(headers or {})})
    return urllib.request.urlopen(req, timeout=60)


def md5_of(path, chunk_size: int = 1 << 20) -> str:
    h = hashlib.md5()
    with open(path, 'rb') as f:
        while data := f.read(chunk_size):
            h.update(data)
    return h.hexdigest()


class ProgressPrinter:
    def __init__(self, label: str):
        self.label = label
        self._last = None
        self._state = None

    def _line(self, done: int, total: int | None) -> str:
        if total is None:
            return f"\r{self.label}: {done / 1e6:,.1f} MB"
        pct = done * 100 // total if total else 100
        return f"\r{self.label}: {done / 1e6:,.1f} / {total / 1e6:,.1f} MB ({pct}%)"

    def __call__(self, done: int, total: int | None):
        self._state = (done, total)
        now = time.monotonic()
        if self._last is None or now - self._last >= 0.5:
            self._last = now
            sys.stderr.write(self._line(done, total))
            sys.stderr.flush()

    def finish(self):
        if self._state is None:
            return
        sys.stderr.write(self._line(*self._state) + "\n")
        sys.stderr.flush()


def fetch_file(url, dest, md5=None, *, progress=None, chunk_size: int = 1 << 20) -> Path:
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + '.part')
    done = part.stat().st_size if part.exists() else 0
    headers = {'Range': f'bytes={done}-'} if done else {}
    try:
        resp = open_url(url, headers)
    except urllib.error.HTTPError as err:
        if err.code != 416:
            raise
    else:
        with resp:
            if done and resp.status == 206:
                mode = 'ab'
            else:
                mode = 'wb'
                done = 0
            length = resp.headers.get('Content-Length')
            total = done + int(length) if length else None
            with open(part, mode) as out:
                while data := resp.read(chunk_size):
                    out.write(data)
                    done += len(data)
                    if progress:
                        progress(done, total)
    if md5:
        actual = md5_of(part)
        if actual != md5.lower():
            part.unlink()
            raise ChecksumError(f"md5 mismatch for {dest.name}: expected {md5}, got {actual}")
    os.replace(part, dest)
    return dest


def copy_verified(src, dest, md5=None, *, progress=None, chunk_size: int = 1 << 20) -> Path:
    src = Path(src)
    if not src.exists():
        raise FileNotFoundError(f"{src} not found")
    if md5:
        actual = md5_of(src)
        if actual != md5.lower():
            raise ChecksumError(f"md5 mismatch for {src.name}: expected {md5}, got {actual}")
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + '.part')
    total = src.stat().st_size
    done = 0
    with open(src, 'rb') as f, open(part, 'wb') as out:
        while data := f.read(chunk_size):
            out.write(data)
            done += len(data)
            if progress:
                progress(done, total)
    os.replace(part, dest)
    return dest


def ensure_file(dest, md5, *, url, from_file=None, label=None, progress=None) -> Path:
    dest = Path(dest)
    label = label or dest.name
    quiet = progress is not None
    if dest.exists() and (md5 is None or md5_of(dest) == md5.lower()):
        if not quiet:
            print(f"{label}: already have {dest} (md5 ok)")
        return dest
    p = progress if quiet else ProgressPrinter(label)
    if from_file:
        copy_verified(from_file, dest, md5, progress=p)
    else:
        fetch_file(url, dest, md5, progress=p)
    if quiet:
        return dest
    p.finish()
    print(f"{label}: saved {dest} (md5 ok)" if md5 else f"{label}: saved {dest}")
    return dest
