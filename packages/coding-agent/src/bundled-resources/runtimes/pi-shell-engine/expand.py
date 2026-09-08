"""Word expansion for the pi shell engine.

Implements `expand_word(word, ctx) -> list[str]`: quoting, tilde, `$VAR`/`${...}`,
`$(...)`/backtick command substitution, globbing, and word-splitting, per
windows-shell-workpackages-2026-07-19.md §1.5/§2.1/WP-B.

Never imports exec. Command substitution goes through the injected
`ctx.run_command_substitution` callable.
"""

from __future__ import annotations

import fnmatch
import os
import re
from typing import TYPE_CHECKING

from arithmetic import ArithmeticError, compile_arithmetic, evaluate_arithmetic
from errors import ArithmeticExpansionError, UnsupportedConstruct
from nodes import Arith, CmdSub, DQ, Lit, Param, Raw, Substitution, Tilde, Word
from tokens import scan_arithmetic_segments

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


def expand_arithmetic_source(src: str, ctx: "ExecContext") -> int:
    """Expand the `$`-forms inside an arithmetic body, then evaluate it against the session state."""
    source = "".join(_expand_segment_as_field(segment, ctx) for segment in scan_arithmetic_segments(src))
    try:
        return evaluate_arithmetic(compile_arithmetic(source), ctx.state)
    except ArithmeticError as exc:
        raise ArithmeticExpansionError(src.strip(), str(exc)) from exc


def _special_value(name: str, ctx: "ExecContext") -> str | None:
    """Positional (`$1`, `${10}`) and special (`$@`, `$*`, `$#`, `$?`, `$$`, `$0`) parameters."""
    positional = ctx.state.positional
    if name.isdigit():
        index = int(name)
        if index == 0:
            return "bash"
        return positional[index - 1] if index <= len(positional) else ""
    if name in ("@", "*"):
        return " ".join(positional)
    if name == "#":
        return str(len(positional))
    if name == "?":
        return str(ctx.state.last_exit_code)
    if name == "$":
        return str(os.getpid())
    return None


def _pattern_regex(pattern: str) -> "re.Pattern[str]":
    """A glob pattern as an unanchored-at-the-end regex (fnmatch anchors with `\\Z`)."""
    translated = fnmatch.translate(pattern)
    if translated.endswith(r"\Z"):
        translated = translated[: -len(r"\Z")]
    return re.compile(translated)


def _strip_prefix(value: str, pattern: str, *, longest: bool) -> str:
    candidates = range(len(value), -1, -1) if longest else range(0, len(value) + 1)
    for cut in candidates:
        if fnmatch.fnmatchcase(value[:cut], pattern):
            return value[cut:]
    return value


def _strip_suffix(value: str, pattern: str, *, longest: bool) -> str:
    candidates = range(0, len(value) + 1) if longest else range(len(value), -1, -1)
    for cut in candidates:
        if fnmatch.fnmatchcase(value[cut:], pattern):
            return value[:cut]
    return value


def _substitute(value: str, pattern: str, replacement: str, *, every: bool) -> str:
    if pattern == "":
        return value
    anchor_start = pattern.startswith("#")
    anchor_end = pattern.startswith("%")
    if anchor_start or anchor_end:
        pattern = pattern[1:]
    regex = _pattern_regex(pattern)
    if anchor_start:
        match = regex.match(value)
        return replacement + value[match.end() :] if match else value
    if anchor_end:
        for cut in range(0, len(value) + 1):
            if fnmatch.fnmatchcase(value[cut:], pattern):
                return value[:cut] + replacement
        return value
    output: list[str] = []
    position = 0
    while position <= len(value):
        match = regex.match(value, position)
        if match is None or match.end() == position:
            if position < len(value):
                output.append(value[position])
            position += 1
            continue
        output.append(replacement)
        position = match.end()
        if not every:
            output.append(value[position:])
            return "".join(output)
    return "".join(output)


def _substring(value: str, spec: str, ctx: "ExecContext") -> str:
    offset_text, _, length_text = spec.partition(":")
    try:
        offset = evaluate_arithmetic(compile_arithmetic(offset_text or "0"), ctx.state)
        length = evaluate_arithmetic(compile_arithmetic(length_text), ctx.state) if length_text.strip() else None
    except ArithmeticError as exc:
        raise ArithmeticExpansionError(spec, str(exc)) from exc
    if offset < 0:
        offset = max(len(value) + offset, 0)
    if length is None:
        return value[offset:]
    if length < 0:
        end = len(value) + length
        return value[offset:end] if end > offset else ""
    return value[offset : offset + length]


def _resolve_param(name: str, op: str | None, arg: "Word | Substitution | None", ctx: "ExecContext") -> tuple[str, bool]:
    """Resolve a Param segment. Returns (text, split_and_glob_eligible).

    split_and_glob_eligible is False here always; callers decide splitting based on
    quoting context (Raw vs DQ), not on the parameter's own nature.
    """
    special = _special_value(name, ctx)
    if special is not None and op is None:
        return special, False

    env = ctx.state.env
    if op == "#len":
        if name in ("@", "*"):
            return str(len(ctx.state.positional)), False
        value = special if special is not None else env.get(name, "")
        return str(len(value)), False

    is_unset = special is None and name not in env
    is_empty = is_unset or (special if special is not None else env.get(name, "")) == ""
    current = special if special is not None else env.get(name, "")

    if op is None:
        return current, False

    if op in ("#", "##", "%", "%%", "/", "//", ":", "^", "^^", ",", ",,"):
        if isinstance(arg, Substitution):
            pattern = _expand_arg_word(arg.pattern, ctx)
            replacement = _expand_arg_word(arg.replacement, ctx)
        else:
            pattern = _expand_arg_word(arg, ctx) if arg is not None else ""
            replacement = ""
        if op in ("#", "##"):
            return _strip_prefix(current, pattern, longest=op == "##"), False
        if op in ("%", "%%"):
            return _strip_suffix(current, pattern, longest=op == "%%"), False
        if op in ("/", "//"):
            return _substitute(current, pattern, replacement, every=op == "//"), False
        if op == ":":
            return _substring(current, pattern, ctx), False
        if op == "^^":
            return current.upper(), False
        if op == ",,":
            return current.lower(), False
        if op == "^":
            return current[:1].upper() + current[1:], False
        return current[:1].lower() + current[1:], False

    if op == ":-":
        if is_empty:
            return _expand_arg_word(arg, ctx) if arg is not None else "", False
        return current, False

    if op == ":=":
        if is_empty:
            value = _expand_arg_word(arg, ctx) if arg is not None else ""
            ctx.state.env[name] = value
            return value, False
        return current, False

    if op == ":+":
        if is_empty:
            return "", False
        return _expand_arg_word(arg, ctx) if arg is not None else "", False

    if op == ":?":
        if is_empty:
            message = _expand_arg_word(arg, ctx) if arg is not None else f"{name}: parameter null or not set"
            raise ParamExpansionError(name, message)
        return current, False

    raise UnsupportedConstruct("parameter-expansion", f"unsupported parameter expansion operator: {op}")


def _expand_arg_word(word: Word, ctx: "ExecContext") -> str:
    fields = expand_word(word, ctx)
    return " ".join(fields)


def expand_word_unsplit(word: Word, ctx: "ExecContext") -> str:
    """Expand a word as one string: no field splitting, no globbing (the `case` subject,
    `[[ ]]` operands, and `case` patterns are expanded this way in bash)."""
    return "".join(_expand_segment_as_field(segment, ctx) for segment in word.segments)


def _expand_dq_fields(segments: list, ctx: "ExecContext") -> list[str] | None:
    """A double-quoted region as fields: `"$@"` yields one field per positional parameter
    (`"a $@ b"` glues the outer text to the first and last); `None` when the region is
    exactly `"$@"` with no positional parameters, which contributes no field at all."""
    fields = [""]
    saw_at = False
    for segment in segments:
        if isinstance(segment, Param) and segment.name == "@" and segment.op is None:
            saw_at = True
            positional = ctx.state.positional
            if not positional:
                continue
            fields[-1] += positional[0]
            fields.extend(positional[1:])
            continue
        fields[-1] += _expand_segment_as_field(segment, ctx)
    if saw_at and not ctx.state.positional and len(segments) == 1:
        return None
    return fields


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
    if isinstance(segment, Arith):
        return str(expand_arithmetic_source(segment.src, ctx))
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
            dq_fields = _expand_dq_fields(segment.segments, ctx)
            if dq_fields is None:
                continue
            for index, text in enumerate(dq_fields):
                if index > 0:
                    flush()
                append_literal(text)
        elif isinstance(segment, Param):
            if segment.name == "@" and segment.op is None:
                for index, value in enumerate(ctx.state.positional):
                    if index > 0:
                        flush()
                    append_splittable(value, raw=True)
                continue
            text, _ = _resolve_param(segment.name, segment.op, segment.arg, ctx)
            append_splittable(text, raw=True)
        elif isinstance(segment, CmdSub):
            text, _exit_code = ctx.run_command_substitution(segment.src, ctx)
            text = text.rstrip("\n")
            append_splittable(text, raw=True)
        elif isinstance(segment, Arith):
            append_splittable(str(expand_arithmetic_source(segment.src, ctx)), raw=True)
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
