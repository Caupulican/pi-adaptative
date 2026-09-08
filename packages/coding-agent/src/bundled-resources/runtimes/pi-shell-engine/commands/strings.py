"""String/path/misc builtins: echo, printf, basename, dirname, which, true, false, pwd, test/[.

Pure builtins: take a BuiltinContext, write to ctx.stdout, return an exit code. Never touch
shell state. Follows windows-shell-workpackages-2026-07-19.md §2.2 exactly, including the
documented divergences.
"""

from __future__ import annotations

import os

from conditional import FILE_BINARY_OPS, INT_BINARY_OPS, UNARY_OPS, eval_file_binary, eval_int_binary, eval_unary
from context import BuiltinContext
from errors import UnsupportedConstruct
from escapes import ECHO_ESCAPES, PRINTF_ESCAPES, decode_backslash_escapes
from paths import resolve_request_path
from shell_args import split_leading_short_options


def _write(ctx: BuiltinContext, data: str) -> None:
    ctx.stdout.write(data.encode("utf-8"))


def cmd_echo(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    newline = True
    interpret = False
    option_args, words = split_leading_short_options(args, "neE")
    for option in option_args:
        for char in option[1:]:
            if char == "n":
                newline = False
            elif char == "e":
                interpret = True
            else:
                interpret = False
    text = " ".join(words)
    if interpret:
        decoded, stop = decode_backslash_escapes(text, ECHO_ESCAPES)
        text = decoded
        if stop:
            _write(ctx, text)
            return 0
    if newline:
        text += "\n"
    _write(ctx, text)
    return 0


def _printf_one(fmt: str, args: list[str]) -> tuple[str, list[str], bool]:
    """Process one FORMAT pass, consuming from args as %-conversions are hit."""
    out: list[str] = []
    i = 0
    n = len(fmt)
    had_error = False
    while i < n:
        ch = fmt[i]
        if ch != "%":
            out.append(ch)
            i += 1
            continue
        if i + 1 < n and fmt[i + 1] == "%":
            out.append("%")
            i += 2
            continue
        j = i + 1
        spec = "%"
        while j < n and fmt[j] in "-+ 0#":
            spec += fmt[j]
            j += 1
        while j < n and fmt[j].isdigit():
            spec += fmt[j]
            j += 1
        if j < n and fmt[j] == ".":
            spec += "."
            j += 1
            while j < n and fmt[j].isdigit():
                spec += fmt[j]
                j += 1
        if j >= n:
            out.append(spec)
            i = j
            continue
        conv = fmt[j]
        spec += conv
        j += 1
        arg = args.pop(0) if args else ""
        try:
            if conv in "di":
                spec = spec[:-1] + "d"
                out.append(spec % int(arg or "0", 0))
            elif conv == "u":
                spec = spec[:-1] + "d"
                out.append(spec % (int(arg or "0", 0) & 0xFFFFFFFF))
            elif conv in "oxX":
                out.append(spec % (int(arg or "0", 0)))
            elif conv == "c":
                out.append(arg[0] if arg else "")
            elif conv == "s":
                out.append(spec % arg)
            elif conv == "f":
                out.append(spec % float(arg or "0"))
            else:
                out.append(spec)
        except ValueError:
            had_error = True
        i = j
    return "".join(out), args, had_error


def cmd_printf(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    if not args:
        raise UnsupportedConstruct("unsupported-flag", "printf: FORMAT operand required")
    fmt_raw = args[0]
    fmt, _ = decode_backslash_escapes(fmt_raw, PRINTF_ESCAPES)
    remaining = args[1:]
    had_error = False
    if not remaining:
        text, _, err = _printf_one(fmt, [])
        had_error = had_error or err
        _write(ctx, text)
    else:
        first = True
        while remaining or first:
            before = len(remaining)
            text, remaining, err = _printf_one(fmt, remaining)
            had_error = had_error or err
            _write(ctx, text)
            first = False
            # A format with no conversions cannot consume another argument. Bash
            # prints it once; continuing would spin forever with the same argv.
            if len(remaining) == before or not remaining:
                break
    return 1 if had_error else 0


def cmd_basename(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    if not args:
        raise UnsupportedConstruct("unsupported-flag", "basename: PATH operand required")
    for a in args:
        if a.startswith("-") and a != "-":
            raise UnsupportedConstruct("unsupported-flag", f"basename: unsupported flag {a!r}")
    path = args[0]
    suffix = args[1] if len(args) > 1 else None
    base = path.rstrip("/")
    base = base.rsplit("/", 1)[-1] if base else "/"
    if suffix and base != suffix and base.endswith(suffix):
        base = base[: -len(suffix)]
    _write(ctx, base + "\n")
    return 0


def cmd_dirname(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    if not args:
        raise UnsupportedConstruct("unsupported-flag", "dirname: PATH operand required")
    for a in args:
        if a.startswith("-") and a != "-":
            raise UnsupportedConstruct("unsupported-flag", f"dirname: unsupported flag {a!r}")
    path = args[0]
    trimmed = path.rstrip("/")
    if "/" not in trimmed:
        result = "."
    else:
        result = trimmed.rsplit("/", 1)[0]
        result = result if result else "/"
    _write(ctx, result + "\n")
    return 0


def _pathext_candidates(name: str, pathext: str) -> list[str]:
    if os.path.splitext(name)[1]:
        return [name]
    exts = [e for e in pathext.split(os.pathsep) if e]
    return [name + ext for ext in exts] if exts else [name]


def cmd_which(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    if not args:
        raise UnsupportedConstruct("unsupported-flag", "which: NAME operand required")
    for a in args:
        if a.startswith("-"):
            raise UnsupportedConstruct("unsupported-flag", f"which: unsupported flag {a!r}")
    name = args[0]
    path_env = ctx.env.get("PATH", "")
    dirs = [d for d in path_env.split(os.pathsep) if d]
    import sys

    is_win = sys.platform == "win32"
    pathext = ctx.env.get("PATHEXT", ".COM;.EXE;.BAT;.CMD") if is_win else ""
    for d in dirs:
        candidates = _pathext_candidates(name, pathext) if is_win else [name]
        for cand in candidates:
            candidate_path = os.path.join(d, cand)
            if os.path.isfile(candidate_path) and (is_win or os.access(candidate_path, os.X_OK)):
                _write(ctx, candidate_path + "\n")
                return 0
    return 1


def cmd_true(ctx: BuiltinContext) -> int:
    return 0


def cmd_false(ctx: BuiltinContext) -> int:
    return 1


def cmd_pwd(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    for a in args:
        if a not in ("-L", "-P"):
            raise UnsupportedConstruct("unsupported-flag", f"pwd: unsupported flag {a!r}")
    _write(ctx, ctx.cwd + "\n")
    return 0


_STRING_BINARY = {"=", "==", "!="}


def _eval_test_expression(args: list[str], cwd: str) -> bool:
    """One `test` expression without combiners: a unary, a binary, or a bare string."""
    if len(args) == 0:
        return False
    if len(args) == 1:
        return len(args[0]) > 0
    if len(args) == 2 and args[0] in UNARY_OPS:
        return eval_unary(args[0], args[1], cwd)
    if len(args) == 3 and args[1] in _STRING_BINARY:
        return (args[0] == args[2]) if args[1] != "!=" else (args[0] != args[2])
    if len(args) == 3 and args[1] in INT_BINARY_OPS:
        try:
            return eval_int_binary(args[1], int(args[0]), int(args[2]))
        except ValueError as exc:
            raise UnsupportedConstruct("unsupported-flag", f"test: integer expression expected: {args!r}") from exc
    if len(args) == 3 and args[1] in FILE_BINARY_OPS:
        return eval_file_binary(args[1], args[0], args[2], cwd)
    raise UnsupportedConstruct("unsupported-flag", f"test: unsupported expression {args!r}")


def _eval_test(args: list[str], cwd: str) -> int:
    """`test` with `!` and the POSIX `-a`/`-o` combiners (`-a` binds tighter than `-o`)."""
    or_groups: list[list[str]] = [[]]
    for arg in args:
        if arg == "-o":
            or_groups.append([])
        else:
            or_groups[-1].append(arg)
    result = False
    for group in or_groups:
        and_terms: list[list[str]] = [[]]
        for arg in group:
            if arg == "-a":
                and_terms.append([])
            else:
                and_terms[-1].append(arg)
        group_result = True
        for term in and_terms:
            negate = False
            while term and term[0] == "!":
                negate = not negate
                term = term[1:]
            value = _eval_test_expression(term, cwd)
            group_result = group_result and (value != negate)
        result = result or group_result
    return 0 if result else 1


def cmd_test(ctx: BuiltinContext) -> int:
    name = ctx.argv[0]
    args = ctx.argv[1:]
    if name == "[":
        if not args or args[-1] != "]":
            raise UnsupportedConstruct("malformed-syntax", "[: missing closing ]")
        args = args[:-1]
    return _eval_test(args, ctx.cwd)
