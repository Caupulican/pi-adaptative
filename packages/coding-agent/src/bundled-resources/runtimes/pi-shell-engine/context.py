"""Frozen ExecContext/BuiltinContext/type-alias module.

Carries only string annotations (`from __future__ import annotations`), so it imports
nothing at runtime and lets WP-B/C/D code against one shared type surface without
same-wave import coupling. Transcribed verbatim from
windows-shell-workpackages-2026-07-19.md §1.5.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, BinaryIO, Callable, Mapping

if TYPE_CHECKING:
    from nodes import Word
    from state import ShellState

BuiltinFn = Callable[["BuiltinContext"], int]


@dataclass
class BuiltinContext:
    """What a PURE builtin (WP-D) may touch."""

    argv: list[str]
    cwd: str
    env: Mapping[str, str]
    stdin: BinaryIO
    stdout: BinaryIO
    # Builtins historically receive only stdin/stdout; stderr is optional so existing direct
    # callers retain the merged-stream behavior while exec.py can pass a redirected sink.
    stderr: BinaryIO | None = None
    # Runs one argv through the engine's own command dispatch (pure builtins, state builtins,
    # external commands with the engine's spawn rules) with the given stdout/stderr sinks and
    # an empty stdin; returns the exit status. Injected by exec.py; a builtin that launches
    # commands (`find -exec`) must never spawn on its own, because `echo` and friends are engine
    # builtins that do not exist as executables on Windows.
    run_argv: Callable[[list[str], BinaryIO, BinaryIO], int] | None = None


@dataclass
class ExecContext:
    """What exec (WP-C) threads through the run."""

    state: "ShellState"
    stdin: BinaryIO
    stdout: BinaryIO
    expand_word: Callable[["Word", "ExecContext"], list[str]]
    run_command_substitution: Callable[[str, "ExecContext"], tuple[str, int]]
    builtins: Mapping[str, BuiltinFn]
    deadline: float | None
    stderr: BinaryIO | int | None = None
    loop_depth: int = 0


# Executor-owned builtins are NOT in commands/REGISTRY: state mutators and `exit`
# need ShellState/control-flow access, while the runner needs the executor.
STATE_BUILTINS = {"cd", "export", "unset", "exit", "break", "continue", "let"}
RUNNER_BUILTINS = {"xargs"}
