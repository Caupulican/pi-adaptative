"""Path resolution at the shell engine's explicit request-cwd boundary."""

from __future__ import annotations

import os
import re

_POSIX_DRIVE_ROOT = re.compile(r"^/(?:mnt/)?([A-Za-z])/(.*)$")


def translate_posix_drive_path(path: str, windows: bool | None = None) -> str:
    """Map Git-Bash `/c/rest` and WSL `/mnt/c/rest` spellings onto `C:/rest` on Windows.

    Linux-trained models emit these constantly; on Windows neither form names a file. Only a
    token that begins with a single-letter drive root is rewritten, so `/c` (a `cmd /c`
    switch) and `/usr/bin` are untouched. Forward slashes stay: Windows APIs accept them and
    the rest of the token is byte-identical. Off Windows the path is returned unchanged.
    """
    if windows is None:
        windows = os.name == "nt"
    if not windows:
        return path
    match = _POSIX_DRIVE_ROOT.match(path)
    if not match:
        return path
    return f"{match.group(1).upper()}:/{match.group(2)}"


def resolve_request_path(cwd: str, path: str) -> str:
    path = translate_posix_drive_path(path)
    candidate = path if os.path.isabs(path) else os.path.join(cwd, path)
    return os.path.normpath(candidate)
