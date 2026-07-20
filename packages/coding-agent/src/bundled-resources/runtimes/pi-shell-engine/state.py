"""Shell state: current working directory + environment, and delta computation.

Owned by WP-C. Pure stdlib. See windows-shell-workpackages-2026-07-19.md §3 (WP-C spec).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


class ShellEnvironment(dict[str, str]):
    """Windows-compatible environment mapping while preserving the first key spelling."""

    def _existing_key(self, key: object) -> str | None:
        if not isinstance(key, str) or os.name != "nt":
            return key if isinstance(key, str) and dict.__contains__(self, key) else None
        folded = key.casefold()
        return next((candidate for candidate in dict.keys(self) if candidate.casefold() == folded), None)

    def __contains__(self, key: object) -> bool:
        return self._existing_key(key) is not None

    def __getitem__(self, key: str) -> str:
        existing = self._existing_key(key)
        if existing is None:
            raise KeyError(key)
        return dict.__getitem__(self, existing)

    def get(self, key: str, default: str | None = None) -> str | None:
        existing = self._existing_key(key)
        return dict.get(self, existing, default) if existing is not None else default

    def __setitem__(self, key: str, value: str) -> None:
        existing = self._existing_key(key)
        dict.__setitem__(self, existing or key, value)

    def __delitem__(self, key: str) -> None:
        existing = self._existing_key(key)
        if existing is None:
            raise KeyError(key)
        dict.__delitem__(self, existing)

    def pop(self, key: str, default=None):
        existing = self._existing_key(key)
        if existing is None:
            return default
        return dict.pop(self, existing)

    def setdefault(self, key: str, default: str = "") -> str:
        existing = self._existing_key(key)
        if existing is not None:
            return dict.__getitem__(self, existing)
        dict.__setitem__(self, key, default)
        return default

    def copy(self) -> "ShellEnvironment":
        return ShellEnvironment(self)


@dataclass
class ShellState:
    """Mutable cwd + env carried through a single engine run."""

    cwd: str
    env: ShellEnvironment = field(default_factory=ShellEnvironment)

    def __post_init__(self) -> None:
        if not isinstance(self.env, ShellEnvironment):
            self.env = ShellEnvironment(self.env)

    def copy(self) -> "ShellState":
        """Return an independent copy (used for subshell isolation)."""
        return ShellState(cwd=self.cwd, env=self.env.copy())

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
