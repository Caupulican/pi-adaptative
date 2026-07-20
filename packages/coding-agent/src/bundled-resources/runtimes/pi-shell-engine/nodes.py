"""Frozen AST dataclasses for the pi shell engine: word segments + command structure.

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
class Param:
    """$VAR / ${VAR} / ${VAR:-word} ... op in {None, ':-', ':=', ':+', ':?', '#len'}."""

    name: str
    op: str | None
    arg: "Word | None"


@dataclass
class CmdSub:
    """$(...) or `...` - raw inner source, re-parsed+run by exec."""

    src: str


@dataclass
class Tilde:
    """Leading ~ (word-start, unquoted only); "" = current user -> $HOME."""

    user: str


Segment = Lit | Raw | DQ | Param | CmdSub | Tilde


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


PipelineElement = SimpleCommand | Subshell | BraceGroup


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
