"""External-command spawn: PATHEXT-aware resolution, pipe wiring, deadline-safe kill.

WP-C owns this pure-stdlib process boundary; its contract is §3 of
windows-shell-workpackages-2026-07-19.md.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
from typing import BinaryIO

from paths import translate_posix_drive_path
from state import ShellState

TIMEOUT_EXIT_CODE = 124

# Command names that dispatch to the real GNU binary (`<gnu_tools_dir>/<name>[.exe]`) when the
# host has one. Models use GNU semantics end to end (`find -maxdepth`, `ls -lt`, `grep -RIn`,
# `stat -c`, `awk`); a hand-written flag matrix can never converge on that surface, so the real
# tool is primary and the Python builtin in commands/ is the floor for hosts without Git for
# Windows. Engine-semantic names (`echo printf test [ pwd true false which`) and the state
# builtins (`cd export unset exit …`) are deliberately absent: they must see engine state.
# Nothing here is prepended to PATH, so `git`, `python`, `rg`, `node` resolve exactly as before.
GNU_PREFERRED_TOOLS: frozenset[str] = frozenset(
    {
        "ls", "dir", "find", "grep", "egrep", "fgrep", "sed", "awk", "gawk",
        "wc", "head", "tail", "sort", "uniq", "cut", "tr", "cat", "stat", "xargs",
        "tee", "diff", "cmp", "file", "date", "env", "basename", "dirname",
        "realpath", "readlink", "touch", "mkdir", "rm", "cp", "mv", "du", "df",
    }
)


def _gnu_binary(name: str, gnu_tools_dir: str | None) -> str | None:
    if not gnu_tools_dir or not name or os.sep in name or (os.altsep and os.altsep in name):
        return None
    candidates = [name + ".exe", name] if os.name == "nt" else [name]
    for candidate in candidates:
        full = os.path.join(gnu_tools_dir, candidate)
        if os.path.isfile(full) and (os.name == "nt" or os.access(full, os.X_OK)):
            return full
    return None


def resolve_gnu_tool(name: str, gnu_tools_dir: str | None) -> str | None:
    """The real GNU binary for a `GNU_PREFERRED_TOOLS` name, or `None` when the host has none.

    Only a bare command word qualifies: a path (`./ls`, `D:/x/ls.exe`) is the caller's explicit
    choice and resolves through the ordinary PATH rules.
    """
    if name not in GNU_PREFERRED_TOOLS:
        return None
    return _gnu_binary(name, gnu_tools_dir)


def resolve_gnu_extra(name: str, gnu_tools_dir: str | None) -> str | None:
    """A bare name that PATH did not resolve but the GNU directory holds (`seq`, `sha256sum`,
    `tac`, `uname`, `tar`, `bash`, …): the directory is the engine's last search entry, so a
    native tool of the same name on PATH keeps precedence and only the otherwise-missing
    Linux vocabulary is filled in."""
    return _gnu_binary(name, gnu_tools_dir)


def _child_env(state: ShellState, resolved: str) -> dict[str, str]:
    """The child's environment. A GNU tool's own children (`xargs … cat`, `find -exec echo`,
    `bash -c`) must resolve the same GNU vocabulary, and ahead of the unrelated Windows
    `find.exe`/`sort.exe` in System32: the MSYS runtime does not add its own `usr/bin` to PATH
    when the parent is a native process, so the engine prepends it for that child only. The
    session environment is untouched."""
    env = state.env.copy()
    gnu_dir = state.gnu_tools_dir
    if gnu_dir and os.path.dirname(resolved) == os.path.normpath(gnu_dir):
        current = env.get("PATH", "") or ""
        env["PATH"] = gnu_dir + (os.pathsep + current if current else "")
    return dict(env)


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


def build_argv(
    resolved_path: str,
    argv: list[str],
    powershell_path: str | None = None,
) -> list[str]:
    """Adapt Windows script targets; direct-exec native executables and POSIX files."""
    lower = resolved_path.lower()
    if lower.endswith(".bat") or lower.endswith(".cmd"):
        return ["cmd", "/c", resolved_path, *argv[1:]]
    if lower.endswith(".ps1") and (powershell_path or os.name == "nt"):
        # PowerShell 7 is the only supported host; Windows PowerShell 5.1 is never a fallback.
        host = powershell_path or ("pwsh.exe" if os.name == "nt" else "pwsh")
        return [host, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolved_path, *argv[1:]]
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
    # A Linux-trained model's `/c/Program Files/.../tool.exe` and its `/mnt/d/repo` arguments
    # mean `C:/...` here; translate every drive-rooted token before resolution and spawn.
    argv = [translate_posix_drive_path(token) for token in argv]
    resolved = (
        resolve_gnu_tool(argv[0], state.gnu_tools_dir)
        or resolve_external(argv[0], state.env, state.cwd)
        or resolve_gnu_extra(argv[0], state.gnu_tools_dir)
    )
    if resolved is None:
        raise FileNotFoundError(argv[0])
    full_argv = build_argv(resolved, argv, state.powershell_path)
    kwargs: dict = {}
    if os.name != "nt":
        kwargs["start_new_session"] = True
    else:
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return subprocess.Popen(
        full_argv,
        cwd=state.cwd,
        env=_child_env(state, resolved),
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
