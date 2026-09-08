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
        # Retained for catalog stability: `$((...))`, `((...))`, and `let` are supported now.
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
        # Arrays (`name=(…)`, `${name[i]}`, `declare -a`): no array model in the engine's env.
        "array",
    }
)


class UnsupportedConstruct(Exception):
    """Raised for any construct outside the frozen grammar/behavior contract."""

    def __init__(self, construct: str, message: str) -> None:
        super().__init__(message)
        self.code = "unsupported"
        self.construct = construct
        self.message = message


class ArithmeticExpansionError(Exception):
    """A `$((...))` / `((...))` body that fails to parse or evaluate (bad token, division by zero).

    Bash-level runtime error, not a grammar refusal: the command containing the expression
    fails with status 1 and a bounded diagnostic while the rest of the command list keeps
    running. Raised by the expander, consumed by the executor at the pipeline-element boundary.
    """

    def __init__(self, expression: str, message: str) -> None:
        super().__init__(message)
        self.expression = expression
        self.message = message


class ShellExit(Exception):
    """Controlled `exit` request carried to the nearest shell boundary."""

    def __init__(self, exit_code: int) -> None:
        super().__init__(exit_code)
        self.exit_code = exit_code


class LoopControl(Exception):
    """Internal non-local control transfer consumed by enclosing loop nodes."""

    def __init__(self, levels: int) -> None:
        super().__init__(levels)
        self.levels = levels


class LoopBreak(LoopControl):
    """Leave one or more enclosing loops."""


class LoopContinue(LoopControl):
    """Continue one or more enclosing loops."""


class FunctionReturn(Exception):
    """`return [n]` inside a function body, consumed by the function call frame."""

    def __init__(self, exit_code: int) -> None:
        super().__init__(exit_code)
        self.exit_code = exit_code


class RedirectError(Exception):
    """A redirect target that cannot be opened (missing directory, permission): a bash-level
    runtime error for the command that carries it, status 1, never a crash."""

    def __init__(self, path: str, reason: str) -> None:
        super().__init__(reason)
        self.path = path
        self.message = f"bash: {path}: {reason}"
