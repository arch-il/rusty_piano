"""Folders of the coach's own data (attempts, sessions, reports) under coach/data, or under the RUSTY_PIANO_DATA_DIR folder."""

import os
from pathlib import Path

DATA_DIR_ENV = "RUSTY_PIANO_DATA_DIR"


def coach_data_dir() -> Path:
    value = os.environ.get(DATA_DIR_ENV)
    if value:
        return Path(value).expanduser().resolve()
    return Path(__file__).resolve().parents[2] / "data"


def attempts_dir(value=None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return coach_data_dir() / "attempts"


def plan_dir(value=None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return coach_data_dir() / "plan"


def sessions_dir(value=None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return coach_data_dir() / "sessions"


def reports_dir(value=None) -> Path:
    if value:
        return Path(value).expanduser().resolve()
    return coach_data_dir() / "reports"
