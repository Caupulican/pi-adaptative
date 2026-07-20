"""Word expansion for the pi shell engine.

Implements `expand_word(word, ctx) -> list[str]`: quoting, tilde, `$VAR`/`${...}`,
`$(...)`/backtick command substitution, globbing, and word-splitting, per
windows-shell-workpackages-2026-07-19.md §1.5/§2.1/WP-B.

Never imports exec. Command substitution goes through the injected
`ctx.run_command_substitution` callable.
"""

from __future__ import annotations

import fnmatch
from typing import TYPE_CHECKING

from errors import UnsupportedConstruct
from nodes import CmdSub, DQ, Lit, Param, Raw, Tilde, Word

if TYPE_CHECKING:
    from context import ExecContext

_IFS_WHITESPACE = " \t\n"


def _split_ifs(text: str) -> list[str]:
    return text.split()


def _glob_sort_key(path: str) -> tuple[str, ...]:
    # Ordinal (LC_ALL=C) sort, per code point.
    return tuple(path)


def _escape_glob_literals(text: str) -> str:
    """Quote glob metacharacters contributed by a quoted/literal word segment."""
    return text.replace("[", "[[]").replace("*", "[*]").replace("?", "[?]")


def _expand_glob(pattern: str, cwd: str, literal_fallback: str) -> list[str]:
    import os

    if not any(ch in pattern for ch in "*?["):
        return [literal_fallback]

    # Support a single path separator component: match directory portion literally,
    # glob only the final segment (sufficient for the frozen matrix: *, ?, [...]).
    normalized = pattern.replace("\\", "/")
    display = literal_fallback.replace("\\", "/")
    if "/" in normalized:
        dir_part, _, name_part = normalized.rpartition("/")
        display_dir_part, _, _ = display.rpartition("/")
        search_dir = dir_part if dir_part else "/"
        base_dir = search_dir if os.path.isabs(search_dir) else os.path.join(cwd, search_dir)
        prefix = display_dir_part + "/"
    else:
        name_part = normalized
        base_dir = cwd
        prefix = ""

    try:
        entries = os.listdir(base_dir)
    except OSError:
        return [literal_fallback]

    # Bash does not let * / ? match a leading dot unless the pattern component
    # itself starts with a dot.
    matches = [
        name
        for name in entries
        if not (name.startswith(".") and not name_part.startswith("."))
        and fnmatch.fnmatchcase(name, name_part)
    ]
    if not matches:
        return [literal_fallback]

    matches.sort(key=_glob_sort_key)
    return [(prefix + name).replace("\\", "/") for name in matches]


class ParamExpansionError(Exception):
    """Raised for `${V:?word}` against an unset-or-empty parameter.

    Bash-level runtime error (not a grammar refusal): prints `word` and aborts the
    command. Not an `UnsupportedConstruct` — the construct itself is fully supported.
    exec.py (WP-C) is free to catch this and surface it as a non-zero exit + message.
    """

    def __init__(self, name: str, message: str) -> None:
        super().__init__(message)
        self.name = name
        self.message = message


def _resolve_param(name: str, op: str | None, arg: Word | None, ctx: "ExecContext") -> tuple[str, bool]:
    """Resolve a Param segment. Returns (text, split_and_glob_eligible).

    split_and_glob_eligible is False here always; callers decide splitting based on
    quoting context (Raw vs DQ), not on the parameter's own nature.
    """
    env = ctx.state.env
    if op == "#len":
        value = env.get(name, "")
        return str(len(value)), False

    is_unset = name not in env
    is_empty = is_unset or env.get(name, "") == ""

    if op is None:
        return env.get(name, ""), False

    if op == ":-":
        if is_empty:
            return _expand_arg_word(arg, ctx) if arg is not None else "", False
        return env[name], False

    if op == ":=":
        if is_empty:
            value = _expand_arg_word(arg, ctx) if arg is not None else ""
            ctx.state.env[name] = value
            return value, False
        return env[name], False

    if op == ":+":
        if is_empty:
            return "", False
        return _expand_arg_word(arg, ctx) if arg is not None else "", False

    if op == ":?":
        if is_empty:
            message = _expand_arg_word(arg, ctx) if arg is not None else f"{name}: parameter null or not set"
            raise ParamExpansionError(name, message)
        return env[name], False

    raise UnsupportedConstruct("parameter-expansion", f"unsupported parameter expansion operator: {op}")


def _expand_arg_word(word: Word, ctx: "ExecContext") -> str:
    fields = expand_word(word, ctx)
    return " ".join(fields)


def _expand_segment_as_field(segment, ctx: "ExecContext") -> str:
    """Expand one segment into exactly one contributing string (no split/glob)."""
    if isinstance(segment, Lit):
        return segment.text
    if isinstance(segment, Raw):
        return segment.text
    if isinstance(segment, DQ):
        return "".join(_expand_segment_as_field(inner, ctx) for inner in segment.segments)
    if isinstance(segment, Param):
        text, _ = _resolve_param(segment.name, segment.op, segment.arg, ctx)
        return text
    if isinstance(segment, CmdSub):
        text, _exit_code = ctx.run_command_substitution(segment.src, ctx)
        return text.rstrip("\n")
    if isinstance(segment, Tilde):
        if segment.user:
            raise UnsupportedConstruct("tilde-user", f"unsupported tilde expansion: ~{segment.user}")
        return ctx.state.env.get("HOME", "")
    raise UnsupportedConstruct("malformed-syntax", f"unrecognized word segment: {type(segment).__name__}")


def expand_word(word: Word, ctx: "ExecContext") -> list[str]:
    """Expand one Word into 0..N argv strings, honoring quoting/splitting/globbing.

    Glob eligibility is tracked per segment. Quoted wildcards stay literal even when
    an adjacent unquoted segment contributes a real wildcard.
    """
    fields: list[tuple[str, str | None]] = []
    current_parts: list[tuple[str, bool]] = []
    current_active = False

    def flush() -> None:
        nonlocal current_parts, current_active
        if current_active:
            text = "".join(part for part, _raw in current_parts)
            has_glob = any(raw and any(ch in part for ch in "*?[") for part, raw in current_parts)
            pattern = "".join(part if raw else _escape_glob_literals(part) for part, raw in current_parts)
            fields.append((text, pattern if has_glob else None))
        current_parts, current_active = [], False

    def append_literal(text: str) -> None:
        nonlocal current_active
        current_parts.append((text, False))
        current_active = True

    def append_splittable(text: str, raw: bool) -> None:
        nonlocal current_active
        if text == "":
            return
        leading_ws = text[0] in _IFS_WHITESPACE
        trailing_ws = text[-1] in _IFS_WHITESPACE
        parts = text.split()
        if not parts:
            # Purely whitespace: acts as a field separator only.
            flush()
            return
        if leading_ws and current_active:
            flush()
        for i, part in enumerate(parts):
            if i > 0:
                flush()
            current_parts.append((part, raw))
            current_active = True
        if trailing_ws:
            flush()

    for segment in word.segments:
        if isinstance(segment, Lit):
            append_literal(segment.text)
        elif isinstance(segment, Raw):
            append_splittable(segment.text, raw=True)
        elif isinstance(segment, DQ):
            text = "".join(_expand_segment_as_field(inner, ctx) for inner in segment.segments)
            append_literal(text)
        elif isinstance(segment, Param):
            text, _ = _resolve_param(segment.name, segment.op, segment.arg, ctx)
            append_splittable(text, raw=True)
        elif isinstance(segment, CmdSub):
            text, _exit_code = ctx.run_command_substitution(segment.src, ctx)
            text = text.rstrip("\n")
            append_splittable(text, raw=True)
        elif isinstance(segment, Tilde):
            if segment.user:
                raise UnsupportedConstruct("tilde-user", f"unsupported tilde expansion: ~{segment.user}")
            append_literal(ctx.state.env.get("HOME", ""))
        else:
            raise UnsupportedConstruct("malformed-syntax", f"unrecognized word segment: {type(segment).__name__}")

    flush()

    result: list[str] = []
    for text, pattern in fields:
        if pattern is not None:
            result.extend(_expand_glob(pattern, ctx.state.cwd, text))
        else:
            result.append(text)
    return result
