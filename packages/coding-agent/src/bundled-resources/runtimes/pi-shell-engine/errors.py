"""Structured refusal exception + the frozen refusal-code catalog for the pi shell engine.

Any construct outside the frozen grammar (see nodes.py / parser.py) raises
`UnsupportedConstruct` with a stable `construct` id from the catalog below. The engine
never returns a partial or guessed AST/result for an unsupported construct.
"""

from __future__ import annotations

# Frozen construct-id catalog (do not rename/remove existing ids; "tilde-user" added per
# architect addendum for ~user forms raised by the expander; "malformed-syntax" and
# "parameter-expansion" added per architect amendment after WP-A review — see
# windows-shell-workpackages-2026-07-19.md §1.6: "malformed-syntax" covers any
# syntactically-broken input (unbalanced quote/paren/brace, stray/trailing tokens, missing
# redirect target, empty pipeline element) so a raw Python exception never escapes;
# "parameter-expansion" covers a `${...}` form outside the supported op set (`:-`, `:=`,
# `:+`, `:?`, `#len`), distinct from "unsupported-flag" which stays builtin-flag-specific.
UNSUPPORTED_CONSTRUCTS = frozenset(
    {
        "job-control",
        "process-substitution",
        "arithmetic-expansion",
        "brace-expansion",
        "nested-shell",
        "exec-builtin",
        "heredoc",
        "here-string",
        "function-definition",
        "control-flow",
        "extended-glob",
        "unsupported-builtin",
        "unsupported-flag",
        "posix-script",
        "cwd-missing",
        "tilde-user",
        "malformed-syntax",
        "parameter-expansion",
    }
)


class UnsupportedConstruct(Exception):
    """Raised for any construct outside the frozen grammar/behavior contract."""

    def __init__(self, construct: str, message: str) -> None:
        super().__init__(message)
        self.code = "unsupported"
        self.construct = construct
        self.message = message
