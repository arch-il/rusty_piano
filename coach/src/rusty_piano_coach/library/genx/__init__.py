import importlib
import pkgutil

from .core import DIVISIONS, Gx, bars, drill, walk, write

__all__ = ["Gx", "write", "walk", "bars", "drill", "DIVISIONS",
           "track_module_names", "collect", "all_exercises", "all_piece_nodes"]


def track_module_names():
    return sorted(m.name for m in pkgutil.iter_modules(__path__) if m.name.startswith("track_"))


def collect(modules):
    exercises = []
    nodes = []
    keys = set()
    ids = set()
    for m in modules:
        for ex in m.EXERCISES:
            if ex.key in keys:
                raise ValueError(f"duplicate exercise key {ex.key}")
            keys.add(ex.key)
            exercises.append(ex)
        for node in getattr(m, "PIECE_NODES", []):
            if node["id"] in ids:
                raise ValueError(f"duplicate piece id {node['id']}")
            ids.add(node["id"])
            nodes.append(node)
    return exercises, nodes


def _modules():
    return [importlib.import_module(f"{__name__}.{name}") for name in track_module_names()]


def all_exercises():
    return collect(_modules())[0]


def all_piece_nodes():
    return collect(_modules())[1]
