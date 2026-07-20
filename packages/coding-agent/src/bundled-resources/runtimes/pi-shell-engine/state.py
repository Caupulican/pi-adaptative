"""Shell state: current working directory + environment, and delta computation.

Owned by WP-C. Pure stdlib. See windows-shell-workpackages-2026-07-19.md §3 (WP-C spec).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass
class ShellState:
    """Mutable cwd + env carried through a single engine run."""

    cwd: str
    env: dict[str, str] = field(default_factory=dict)

    def copy(self) -> "ShellState":
        """Return an independent copy (used for subshell isolation)."""
        return ShellState(cwd=self.cwd, env=dict(self.env))

    def chdir(self, path: str) -> None:
        """Validate `path` exists and is a directory, then update cwd + OLDPWD."""
        target = path if os.path.isabs(path) else os.path.join(self.cwd, path)
        target = os.path.normpath(target)
        if not os.path.isdir(target):
            raise FileNotFoundError(target)
        self.env["OLDPWD"] = self.cwd
        self.cwd = target

    def setenv(self, name: str, value: str) -> None:
        self.env[name] = value

    def unsetenv(self, name: str) -> None:
        self.env.pop(name, None)

    def delta(self, original_env: dict[str, str]) -> dict[str, str | None]:
        """Compute envDelta vs `original_env`: changed/added -> value, removed -> None."""
        result: dict[str, str | None] = {}
        for key, value in self.env.items():
            if key not in original_env or original_env[key] != value:
                result[key] = value
        for key in original_env:
            if key not in self.env:
                result[key] = None
        return result
