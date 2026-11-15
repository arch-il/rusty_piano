"""Tests for the one-at-a-time background job runner."""

import tarfile
import threading

import pytest

from rusty_piano_coach.jobs import Busy, Jobs


def test_job_runs_and_finishes():
    jobs = Jobs()
    job = jobs.start(kind="download", source="pdmx", target="pdmx:QmFakeAAAA",
                     label="Download Hymn Test", work=lambda progress: "Downloaded Hymn Test")
    assert job["state"] == "running"
    assert job["id"] == 1
    done = jobs.wait()
    assert done["state"] == "done"
    assert done["message"] == "Downloaded Hymn Test"
    assert done["error"] is None


def test_progress_is_visible_while_running():
    jobs = Jobs()
    release = threading.Event()
    reached = threading.Event()

    def work(progress):
        progress("Downloading", 5, 10, "bytes")
        reached.set()
        release.wait(5)

    try:
        jobs.start(kind="setup", source="pdmx", target="archive", label="PDMX: Score archive", work=work)
        assert reached.wait(5)
        current = jobs.current()
        assert current["phase"] == "Downloading"
        assert current["done"] == 5
        assert current["total"] == 10
        assert current["unit"] == "bytes"
    finally:
        release.set()
    assert jobs.wait()["state"] == "done"


def test_progress_without_unit_keeps_bytes():
    jobs = Jobs()
    jobs.start(kind="setup", source="pdmx", target="catalogue", label="PDMX: Catalogue",
               work=lambda progress: progress("Loading catalogue rows", 3, None))
    jobs.wait()
    current = jobs.current()
    assert current["phase"] == "Loading catalogue rows"
    assert current["unit"] == "bytes"


def test_second_start_is_refused_while_one_runs():
    jobs = Jobs()
    release = threading.Event()

    def hold(progress):
        release.wait(5)

    try:
        jobs.start(kind="download", source="pdmx", target="pdmx:QmFakeAAAA",
                   label="Download Hymn Test", work=hold)
        with pytest.raises(Busy) as info:
            jobs.start(kind="download", source="pdmx", target="pdmx:QmFakeDDDD",
                       label="Download Duet Test", work=hold)
        assert "Download Hymn Test" in str(info.value)
        assert "Wait for it to finish" in str(info.value)
        assert jobs.running() is not None
    finally:
        release.set()
    jobs.wait()
    second = jobs.start(kind="download", source="pdmx", target="pdmx:QmFakeDDDD",
                        label="Download Duet Test", work=lambda progress: "ok")
    assert second["id"] == 2
    jobs.wait()


def test_file_not_found_error_text():
    jobs = Jobs()

    def work(progress):
        raise FileNotFoundError("no such file x")

    jobs.start(kind="download", source="pdmx", target="x", label="Download x", work=work)
    job = jobs.wait()
    assert job["state"] == "error"
    assert job["error"] == "no such file x"


def test_damaged_archive_error_text():
    jobs = Jobs()

    def work(progress):
        raise tarfile.ReadError("bad")

    jobs.start(kind="setup", source="pdmx", target="archive", label="PDMX: Score archive", work=work)
    job = jobs.wait()
    assert job["state"] == "error"
    assert job["error"].startswith("archive is damaged")


def test_unexpected_error_text():
    jobs = Jobs()

    def work(progress):
        raise RuntimeError("boom")

    jobs.start(kind="download", source="pdmx", target="x", label="Download x", work=work)
    job = jobs.wait()
    assert job["state"] == "error"
    assert job["error"] == "internal error: boom"


def test_current_is_none_then_a_copy():
    jobs = Jobs()
    assert jobs.current() is None
    jobs.start(kind="setup", source="pdmx", target="catalogue", label="PDMX: Catalogue",
               work=lambda progress: "ok")
    jobs.wait()
    copy = jobs.current()
    copy["phase"] = "changed"
    assert jobs.current()["phase"] != "changed"
