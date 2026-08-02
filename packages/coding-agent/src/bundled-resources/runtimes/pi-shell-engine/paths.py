"""Path resolution at the shell engine's explicit request-cwd boundary."""

from __future__ import annotations

import os


def resolve_request_path(cwd: str, path: str) -> str:
    candidate = path if os.path.isabs(path) else os.path.join(cwd, path)
    return os.path.normpath(candidate)
