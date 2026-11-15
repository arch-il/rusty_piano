"""Smoke test: the coach package and all its modules import."""

import importlib

MODULES = [
    "rusty_piano_coach",
    "rusty_piano_coach.cli",
    "rusty_piano_coach.server",
    "rusty_piano_coach.jobs",
    "rusty_piano_coach.scores",
    "rusty_piano_coach.data_paths",
    "rusty_piano_coach.attempts",
    "rusty_piano_coach.attempts_cli",
    "rusty_piano_coach.analyse_cli",
    "rusty_piano_coach.practice_log",
    "rusty_piano_coach.sessions",
    "rusty_piano_coach.compare",
    "rusty_piano_coach.reports",
    "rusty_piano_coach.trends",
    "rusty_piano_coach.library",
    "rusty_piano_coach.library.paths",
    "rusty_piano_coach.library.index",
    "rusty_piano_coach.library.analyse",
    "rusty_piano_coach.library.difficulty",
    "rusty_piano_coach.library.fetch",
    "rusty_piano_coach.library.sources",
    "rusty_piano_coach.library.local",
    "rusty_piano_coach.library.pdmx",
    "rusty_piano_coach.library.cli",
    "rusty_piano_coach.fingering_jobs",
    "rusty_piano_coach.fingering_cli",
    "rusty_piano_coach.library.fingering",
    "rusty_piano_coach.library.scale_fingering",
]


def test_package_imports():
    for name in MODULES:
        importlib.import_module(name)
