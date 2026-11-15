import hashlib
import io
import os
import urllib.error

import pytest

from rusty_piano_coach.library import fetch


class FakeResponse:
    def __init__(self, status, body: bytes, headers: dict):
        self.status = status
        self.headers = headers
        self._body = io.BytesIO(body)

    def read(self, n):
        return self._body.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def no_network(*args, **kwargs):
    raise AssertionError("network must not be called")


def test_fresh_download_is_chunked_and_verified(tmp_path, monkeypatch):
    body = os.urandom(3 * 1024 * 1024)
    calls = []

    def fake_open(url, headers=None):
        calls.append(headers)
        return FakeResponse(200, body, {'Content-Length': str(len(body))})

    monkeypatch.setattr(fetch, 'open_url', fake_open)
    progress_calls = []
    dest = tmp_path / 'x.bin'
    fetch.fetch_file(
        'http://example.test/x',
        dest,
        hashlib.md5(body).hexdigest(),
        progress=lambda done, total: progress_calls.append((done, total)),
        chunk_size=1 << 20,
    )
    assert dest.read_bytes() == body
    assert not (tmp_path / 'x.bin.part').exists()
    assert progress_calls[-1] == (len(body), len(body))
    assert 'Range' not in calls[0]


def test_resume_appends_from_part(tmp_path, monkeypatch):
    body = os.urandom(5000)
    dest = tmp_path / 'x.bin'
    part = tmp_path / 'x.bin.part'
    part.write_bytes(body[:1000])

    def fake_open(url, headers=None):
        assert headers['Range'] == 'bytes=1000-'
        return FakeResponse(206, body[1000:], {'Content-Length': str(len(body) - 1000)})

    monkeypatch.setattr(fetch, 'open_url', fake_open)
    fetch.fetch_file('http://example.test/x', dest, hashlib.md5(body).hexdigest())
    assert dest.read_bytes() == body


def test_server_ignoring_range_restarts(tmp_path, monkeypatch):
    body = os.urandom(5000)
    dest = tmp_path / 'x.bin'
    (tmp_path / 'x.bin.part').write_bytes(body[:1000])

    def fake_open(url, headers=None):
        return FakeResponse(200, body, {'Content-Length': str(len(body))})

    monkeypatch.setattr(fetch, 'open_url', fake_open)
    fetch.fetch_file('http://example.test/x', dest, hashlib.md5(body).hexdigest())
    assert dest.read_bytes() == body


def test_416_with_complete_part_creates_dest(tmp_path, monkeypatch):
    body = os.urandom(3000)
    dest = tmp_path / 'x.bin'
    (tmp_path / 'x.bin.part').write_bytes(body)

    def fake_open(url, headers=None):
        raise urllib.error.HTTPError(url, 416, 'Range Not Satisfiable', {}, None)

    monkeypatch.setattr(fetch, 'open_url', fake_open)
    fetch.fetch_file('http://example.test/x', dest, hashlib.md5(body).hexdigest())
    assert dest.read_bytes() == body


def test_md5_mismatch_leaves_no_files(tmp_path, monkeypatch):
    body = os.urandom(3000)
    dest = tmp_path / 'x.bin'

    def fake_open(url, headers=None):
        return FakeResponse(200, body, {'Content-Length': str(len(body))})

    monkeypatch.setattr(fetch, 'open_url', fake_open)
    with pytest.raises(fetch.ChecksumError):
        fetch.fetch_file('http://example.test/x', dest, '0' * 32)
    assert not dest.exists()
    assert not (tmp_path / 'x.bin.part').exists()


def test_ensure_file_skips_download_when_md5_matches(tmp_path, monkeypatch, capsys):
    body = os.urandom(3000)
    dest = tmp_path / 'x.bin'
    dest.write_bytes(body)
    monkeypatch.setattr(fetch, 'open_url', no_network)
    result = fetch.ensure_file(dest, hashlib.md5(body).hexdigest(), url='http://example.test/x')
    assert result == dest
    assert 'already have' in capsys.readouterr().out


def test_ensure_file_from_local_copy_is_verified(tmp_path, monkeypatch):
    body = os.urandom(3000)
    md5 = hashlib.md5(body).hexdigest()
    src = tmp_path / 'src.bin'
    src.write_bytes(body)
    monkeypatch.setattr(fetch, 'open_url', no_network)

    dest = tmp_path / 'out' / 'copy.bin'
    fetch.ensure_file(dest, md5, url='http://example.test/x', from_file=src)
    assert dest.read_bytes() == body

    bad_dest = tmp_path / 'bad.bin'
    with pytest.raises(fetch.ChecksumError):
        fetch.ensure_file(bad_dest, '0' * 32, url='http://example.test/x', from_file=src)
    assert not bad_dest.exists()

    with pytest.raises(FileNotFoundError):
        fetch.ensure_file(tmp_path / 'y.bin', md5, url='http://example.test/x', from_file=tmp_path / 'missing.bin')


def test_md5_of_matches_hashlib(tmp_path):
    body = os.urandom(3 * 1024 * 1024 + 7)
    path = tmp_path / 'b.bin'
    path.write_bytes(body)
    assert fetch.md5_of(path, chunk_size=4096) == hashlib.md5(body).hexdigest()
