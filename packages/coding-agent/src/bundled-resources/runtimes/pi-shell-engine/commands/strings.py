"""String/path/misc builtins: echo, printf, basename, dirname, which, true, false, pwd, test/[.

Pure builtins: take a BuiltinContext, write to ctx.stdout, return an exit code. Never touch
shell state. Follows windows-shell-workpackages-2026-07-19.md §2.2 exactly, including the
documented divergences.
"""

from __future__ import annotations

import os

from context import BuiltinContext
from errors import UnsupportedConstruct


def _write(ctx: BuiltinContext, data: str) -> None:
    ctx.stdout.write(data.encode("utf-8"))


def _decode_backslash_escapes(text: str, *, allow_c: bool) -> tuple[str, bool]:
    """Decode the echo/printf escape set. Returns (decoded, stop_output_early)."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nxt = text[i + 1]
        if nxt == "\\":
            out.append("\\")
            i += 2
        elif nxt == "a":
            out.append("\a")
            i += 2
        elif nxt == "b":
            out.append("\b")
            i += 2
        elif nxt == "c":
            if allow_c:
                return "".join(out), True
            out.append("\\c")
            i += 2
        elif nxt == "e":
            out.append("\x1b")
            i += 2
        elif nxt == "f":
            out.append("\f")
            i += 2
        elif nxt == "n":
            out.append("\n")
            i += 2
        elif nxt == "r":
            out.append("\r")
            i += 2
        elif nxt == "t":
            out.append("\t")
            i += 2
        elif nxt == "v":
            out.append("\v")
            i += 2
        elif nxt == "0":
            j = i + 2
            digits = ""
            while j < n and len(digits) < 3 and text[j] in "01234567":
                digits += text[j]
                j += 1
            if digits:
                out.append(chr(int(digits, 8) & 0xFF))
                i = j
            else:
                out.append("\0")
                i += 2
        elif nxt == "x":
            j = i + 2
            digits = ""
            while j < n and len(digits) < 2 and text[j] in "0123456789abcdefABCDEF":
                digits += text[j]
                j += 1
            if digits:
                out.append(chr(int(digits, 16) & 0xFF))
                i = j
            else:
                out.append("\\x")
                i += 2
        else:
            out.append("\\")
            out.append(nxt)
            i += 2
    return "".join(out), False


def cmd_echo(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    newline = True
    interpret = False
    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--":
            idx += 1
            break
        if arg == "-n":
            newline = False
            idx += 1
            continue
        if arg == "-e":
            interpret = True
            idx += 1
            continue
        if arg == "-E":
            interpret = False
            idx += 1
            continue
        if arg.startswith("-") and arg != "-" and all(c in "neE" for c in arg[1:]) and len(arg) > 1:
            for c in arg[1:]:
                if c == "n":
                    newline = False
                elif c == "e":
                    interpret = True
                elif c == "E":
                    interpret = False
            idx += 1
            continue
        break
    words = args[idx:]
    text = " ".join(words)
    if interpret:
        decoded, stop = _decode_backslash_escapes(text, allow_c=True)
        text = decoded
        if stop:
            _write(ctx, text)
            return 0
    if newline:
        text += "\n"
    _write(ctx, text)
    return 0


def _printf_format_escapes(fmt: str) -> str:
    decoded, _ = _decode_backslash_escapes(fmt, allow_c=False)
    return decoded


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
    fmt = _printf_format_escapes(fmt_raw)
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
            if len(remaining) == before and not remaining:
                break
            if not remaining:
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


_UNARY_OPS = {"-e", "-f", "-d", "-r", "-w", "-x", "-s", "-n", "-z"}
_STRING_BINARY = {"=", "!="}
_INT_BINARY = {"-eq", "-ne", "-lt", "-le", "-gt", "-ge"}
_PATH_UNARY_OPS = {"-e", "-f", "-d", "-r", "-w", "-x", "-s"}


def _resolve(cwd: str, path: str) -> str:
    """Resolve `path` against `cwd` (see commands/fs.py's `_resolve`: main.py never os.chdir()s
    to the request cwd, so every relative path operand must resolve against ctx.cwd here too)."""
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(cwd, path))


def _eval_unary(op: str, operand: str, cwd: str) -> bool:
    if op in _PATH_UNARY_OPS:
        operand = _resolve(cwd, operand)
    if op == "-e":
        return os.path.exists(operand)
    if op == "-f":
        return os.path.isfile(operand)
    if op == "-d":
        return os.path.isdir(operand)
    if op == "-r":
        return os.access(operand, os.R_OK)
    if op == "-w":
        return os.access(operand, os.W_OK)
    if op == "-x":
        return os.access(operand, os.X_OK)
    if op == "-s":
        return os.path.exists(operand) and os.path.getsize(operand) > 0
    if op == "-n":
        return len(operand) > 0
    if op == "-z":
        return len(operand) == 0
    raise AssertionError(op)


def _eval_test(args: list[str], cwd: str) -> int:
    negate = False
    if args and args[0] == "!":
        negate = True
        args = args[1:]
    for a in args:
        if a in ("-a", "-o"):
            raise UnsupportedConstruct("unsupported-flag", f"test: combiner {a!r} is unsupported")
    result: bool
    if len(args) == 0:
        result = False
    elif len(args) == 1:
        result = len(args[0]) > 0
    elif len(args) == 2 and args[0] in _UNARY_OPS:
        result = _eval_unary(args[0], args[1], cwd)
    elif len(args) == 3 and args[1] in _STRING_BINARY:
        result = (args[0] == args[2]) if args[1] == "=" else (args[0] != args[2])
    elif len(args) == 3 and args[1] in _INT_BINARY:
        left = int(args[0])
        right = int(args[2])
        op = args[1]
        result = {
            "-eq": left == right,
            "-ne": left != right,
            "-lt": left < right,
            "-le": left <= right,
            "-gt": left > right,
            "-ge": left >= right,
        }[op]
    else:
        raise UnsupportedConstruct("unsupported-flag", f"test: unsupported expression {args!r}")
    if negate:
        result = not result
    return 0 if result else 1


def cmd_test(ctx: BuiltinContext) -> int:
    name = ctx.argv[0]
    args = ctx.argv[1:]
    if name == "[":
        if not args or args[-1] != "]":
            raise UnsupportedConstruct("malformed-syntax", "[: missing closing ]")
        args = args[:-1]
    return _eval_test(args, ctx.cwd)
