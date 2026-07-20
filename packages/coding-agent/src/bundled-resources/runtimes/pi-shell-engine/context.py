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
    stderr: BinaryIO


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


# Frozen inline sets: state mutators and the runner builtin are NOT in commands/REGISTRY;
# exec.py handles them inline because they need ShellState / the executor.
STATE_BUILTINS = {"cd", "export", "unset"}
RUNNER_BUILTINS = {"xargs"}
