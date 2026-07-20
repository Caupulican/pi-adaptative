"""External-command spawn: PATHEXT-aware resolution, pipe wiring, deadline-safe kill.

Owned by WP-C. Pure stdlib. See windows-shell-workpackages-2026-07-19.md §3 (WP-C spec).
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from typing import BinaryIO

from state import ShellState

TIMEOUT_EXIT_CODE = 124


def resolve_external(name: str, env: dict[str, str], cwd: str | None = None) -> str | None:
    """Resolve `name` to an absolute path over `env["PATH"]`, honoring PATHEXT on win32.

    Direct `.exe` (or extension-less on POSIX) targets resolve as-is; `.bat`/`.cmd`
    targets are still resolved to a path (the caller wraps them via `cmd /c`).

    Thread-safe: pipeline stages may resolve concurrently on threads, so this never
    reads or mutates `os.environ` (which `shutil.which` does internally for PATH).
    Manual resolution only, entirely off the request env passed in.
    """
    path_value = env.get("PATH", "")
    if os.path.isabs(name) or os.sep in name or (os.altsep and os.altsep in name):
        candidate = name if os.path.isabs(name) else os.path.join(cwd or os.getcwd(), name)
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
        return None

    path_dirs = [d for d in path_value.split(os.pathsep) if d]

    if os.name == "nt":
        pathext = env.get("PATHEXT") or ".COM;.EXE;.BAT;.CMD"
        exts = [e for e in pathext.split(os.pathsep) if e]
        has_ext = any(name.lower().endswith(ext.lower()) for ext in exts)
        candidates = [name] if has_ext else [name + ext for ext in exts] + [name]
        for directory in path_dirs:
            for candidate in candidates:
                full = os.path.join(directory, candidate)
                if os.path.isfile(full):
                    return full
        return None

    for directory in path_dirs:
        base_dir = directory if os.path.isabs(directory) else os.path.join(cwd or os.getcwd(), directory)
        full = os.path.join(base_dir, name)
        if os.path.isfile(full) and os.access(full, os.X_OK):
            return full
    return None


def build_argv(resolved_path: str, argv: list[str]) -> list[str]:
    """Wrap `.bat`/`.cmd` targets via `cmd /c`; direct-exec everything else."""
    lower = resolved_path.lower()
    if lower.endswith(".bat") or lower.endswith(".cmd"):
        return ["cmd", "/c", resolved_path, *argv[1:]]
    return [resolved_path, *argv[1:]]


def spawn_external(
    argv: list[str],
    state: ShellState,
    stdin: BinaryIO | int,
    stdout: BinaryIO | int,
    stderr: BinaryIO | int,
    deadline: float | None,
) -> "subprocess.Popen[bytes]":
    """Resolve argv[0] and spawn it (no shell) with the given cwd/env/streams.

    Raises FileNotFoundError if argv[0] does not resolve.
    """
    resolved = resolve_external(argv[0], state.env, state.cwd)
    if resolved is None:
        raise FileNotFoundError(argv[0])
    full_argv = build_argv(resolved, argv)
    kwargs: dict = {}
    if os.name != "nt":
        kwargs["start_new_session"] = True
    else:
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return subprocess.Popen(
        full_argv,
        cwd=state.cwd,
        env=dict(state.env),
        stdin=stdin,
        stdout=stdout,
        stderr=stderr,
        **kwargs,
    )


def kill_process_tree(proc: "subprocess.Popen[bytes]") -> None:
    """Best-effort kill of `proc` and its children."""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def wait_with_deadline(proc: "subprocess.Popen[bytes]", deadline: float | None) -> int:
    """Wait for `proc`; if `deadline` (a `time.monotonic()` budget) elapses first, kill it.

    Returns the process exit code, or 124 on deadline breach.
    """
    if deadline is None:
        return proc.wait()
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        kill_process_tree(proc)
        return TIMEOUT_EXIT_CODE
    try:
        return proc.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        kill_process_tree(proc)
        return TIMEOUT_EXIT_CODE
