"""AST dataclasses for the pi shell engine: word segments + command structure.

Transcribed verbatim from windows-shell-workpackages-2026-07-19.md §1.4. Type tags for
tests come from `type(node).__name__`; do NOT add a `kind` field to any node.
"""

from __future__ import annotations

from dataclasses import dataclass

# --- Word tier: segments (the expander's input) -----------------------------------


@dataclass
class Lit:
    """Single-quoted / backslash-escaped text: no expansion, no glob, no split."""

    text: str


@dataclass
class Raw:
    """Unquoted literal run: subject to glob + (post-expansion) word-splitting."""

    text: str


@dataclass
class DQ:
    """Double-quoted region: $-expansion yes; glob/split NO."""

    segments: list["Segment"]


@dataclass
class Substitution:
    """The `pattern/replacement` argument of `${VAR/pattern/replacement}`."""

    pattern: "Word"
    replacement: "Word"


@dataclass
class Param:
    """$VAR / ${VAR} / ${VAR:-word} ... op in {None, ':-', ':=', ':+', ':?', '#len', '#', '##',
    '%', '%%', '/', '//', ':', '^', '^^', ',', ',,'}. Special names: digits (positional), '@',
    '*', '#', '?', '$', '0'."""

    name: str
    op: str | None
    arg: "Word | Substitution | None"


@dataclass
class CmdSub:
    """$(...) or `...` - raw inner source, re-parsed+run by exec."""

    src: str


@dataclass
class Arith:
    """$((...)) - raw inner expression; `$`-forms expand first, then it is evaluated as an integer."""

    src: str


@dataclass
class Tilde:
    """Leading ~ (word-start, unquoted only); "" = current user -> $HOME."""

    user: str


Segment = Lit | Raw | DQ | Param | CmdSub | Arith | Tilde


@dataclass
class Word:
    segments: list[Segment]


# --- Command tier: the parser's output ---------------------------------------------


@dataclass
class Redirect:
    """fd source, operator, and target (or dup fd)."""

    op: str
    fd: int | None
    target: "Word | None"
    dup_fd: int | None


@dataclass
class SimpleCommand:
    assignments: list[tuple[str, "Word"]]
    words: list["Word"]
    redirects: list["Redirect"]


@dataclass
class Subshell:
    body: "CommandList"
    redirects: list["Redirect"]


@dataclass
class BraceGroup:
    body: "CommandList"
    redirects: list["Redirect"]


@dataclass
class ForCommand:
    """POSIX word-list loop, including the omitted-``in`` positional form."""

    name: str
    items: list["Word"]
    body: "CommandList"
    redirects: list["Redirect"]


@dataclass
class ArithmeticForCommand:
    """Bash arithmetic loop: ``for ((init; condition; update)); do ...; done``."""

    initializer: str
    condition: str
    update: str
    body: "CommandList"
    redirects: list["Redirect"]


@dataclass
class ArithmeticCommand:
    """Standalone ``((expression))``: exits 0 when the value is non-zero, 1 otherwise."""

    expression: str
    redirects: list["Redirect"]


@dataclass
class IfCommand:
    """``if/elif/.../else/fi`` chain.

    ``branches`` is an ordered list of ``(condition, body)`` pairs — ``if`` first, then
    each ``elif`` in source order. The exit status of the LAST command in a branch's
    condition list decides whether that branch's body runs; the first branch whose
    condition exits 0 wins and no later branch (elif or else) is evaluated.
    """

    branches: list[tuple["CommandList", "CommandList"]]
    else_body: "CommandList | None"
    redirects: list["Redirect"]


@dataclass
class WhileCommand:
    """``while condition; do body; done`` — body runs while condition exits 0."""

    condition: "CommandList"
    body: "CommandList"
    redirects: list["Redirect"]


@dataclass
class UntilCommand:
    """``until condition; do body; done`` — body runs while condition exits non-zero."""

    condition: "CommandList"
    body: "CommandList"
    redirects: list["Redirect"]


@dataclass
class CaseCommand:
    """``case word in pattern|pattern) body ;; … esac``.

    Each clause is ``(patterns, body, terminator)``; the terminator is ``;;`` (stop), ``;&``
    (fall through into the next body unconditionally) or ``;;&`` (keep testing later clauses).
    """

    word: "Word"
    clauses: list[tuple[list["Word"], "CommandList", str]]
    redirects: list["Redirect"]


@dataclass
class ConditionalCommand:
    """``[[ … ]]``: the operand words and structural operators (``!``, ``(``, ``)``, ``&&``,
    ``||``, ``<``, ``>``) between the brackets, in source order; exec evaluates them lazily."""

    items: list["Word | str"]
    redirects: list["Redirect"]


@dataclass
class FunctionDefinition:
    """``name() compound`` / ``function name compound``; defining it registers the body."""

    name: str
    body: "PipelineElement"
    redirects: list["Redirect"]


PipelineElement = (
    SimpleCommand
    | Subshell
    | BraceGroup
    | ForCommand
    | ArithmeticForCommand
    | ArithmeticCommand
    | IfCommand
    | WhileCommand
    | UntilCommand
    | CaseCommand
    | ConditionalCommand
    | FunctionDefinition
)


@dataclass
class Pipeline:
    elements: list[PipelineElement]
    negated: bool


@dataclass
class AndOr:
    pipelines: list["Pipeline"]
    operators: list[str]


@dataclass
class CommandList:
    entries: list["AndOr"]
    separators: list[str]
