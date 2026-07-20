"""Search/transform builtins: grep, sed.

Pure builtins per windows-shell-workpackages-2026-07-19.md §2.2. Regex dialect is Python
`re` (documented divergence from POSIX BRE/ERE).
"""

from __future__ import annotations

import os
import re

from context import BuiltinContext
from errors import UnsupportedConstruct

_GREP_FLAGS = set("ivnclwFE")


def _resolve(cwd: str, path: str) -> str:
    """Resolve `path` against `cwd` (see commands/fs.py's `_resolve`: main.py never os.chdir()s
    to the request cwd, so every relative FILE operand must resolve against ctx.cwd here too)."""
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(cwd, path))


def cmd_grep(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    flags: set[str] = set()
    idx = 0
    while idx < len(args):
        arg = args[idx]
        if arg == "--":
            idx += 1
            break
        if arg.startswith("-") and arg != "-" and len(arg) > 1:
            for c in arg[1:]:
                if c not in _GREP_FLAGS:
                    raise UnsupportedConstruct("unsupported-flag", f"grep: unsupported flag '-{c}'")
                flags.add(c)
            idx += 1
            continue
        break
    remaining = args[idx:]
    if not remaining:
        raise UnsupportedConstruct("unsupported-flag", "grep: PATTERN operand required")
    pattern = remaining[0]
    files = remaining[1:]

    ignore_case = "i" in flags
    invert = "v" in flags
    show_lineno = "n" in flags
    count_only = "c" in flags
    files_only = "l" in flags
    whole_word = "w" in flags
    fixed = "F" in flags

    if fixed:
        needle = pattern
    else:
        pat = pattern
        if whole_word:
            pat = r"\b" + pat + r"\b"
        re_flags = re.IGNORECASE if ignore_case else 0
        try:
            compiled = re.compile(pat, re_flags)
        except re.error as exc:
            raise UnsupportedConstruct("malformed-syntax", f"grep: invalid pattern: {exc}") from exc

    def matches(line: str) -> bool:
        if fixed:
            hay = line.lower() if ignore_case else line
            n = needle.lower() if ignore_case else needle
            if whole_word:
                return re.search(r"(?<!\w)" + re.escape(n) + r"(?!\w)", hay) is not None
            return n in hay
        return compiled.search(line) is not None

    def read_lines(data: bytes) -> list[str]:
        text = data.decode("utf-8", errors="replace")
        if text == "":
            return []
        lines = text.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        return lines

    multi_file = len(files) > 1
    any_match = False
    any_error = False
    out_lines: list[str] = []

    def process(name: str, lines: list[str]) -> None:
        nonlocal any_match
        matched = [ln for ln in lines if matches(ln) != invert]
        if matched:
            any_match = True
        if count_only:
            prefix = f"{name}:" if multi_file else ""
            out_lines.append(f"{prefix}{len(matched)}")
            return
        if files_only:
            if matched:
                out_lines.append(name)
            return
        for i, ln in enumerate(lines):
            if matches(ln) == invert:
                continue
            prefix = ""
            if multi_file:
                prefix += f"{name}:"
            if show_lineno:
                prefix += f"{i + 1}:"
            out_lines.append(f"{prefix}{ln}")

    if not files:
        data = ctx.stdin.read()
        process("(standard input)", read_lines(data))
    else:
        for name in files:
            try:
                with open(_resolve(ctx.cwd, name), "rb") as fh:
                    data = fh.read()
            except OSError as exc:
                out_lines_msg = f"grep: {name}: {exc.strerror or exc}"
                ctx.stdout.write((out_lines_msg + "\n").encode("utf-8"))
                any_error = True
                continue
            process(name, read_lines(data))

    if out_lines:
        ctx.stdout.write(("\n".join(out_lines) + "\n").encode("utf-8"))

    if any_error:
        return 2
    return 0 if any_match else 1


def _parse_sed_replacement(repl: str) -> str:
    """Translate sed REPL (\\1..\\9, &, \\&) into Python re replacement syntax."""
    out: list[str] = []
    i = 0
    n = len(repl)
    while i < n:
        ch = repl[i]
        if ch == "\\" and i + 1 < n:
            nxt = repl[i + 1]
            if nxt.isdigit():
                out.append("\\g<" + nxt + ">")
                i += 2
                continue
            if nxt == "&":
                out.append("&")
                i += 2
                continue
            if nxt == "\\":
                out.append("\\\\")
                i += 2
                continue
            out.append(nxt)
            i += 2
            continue
        if ch == "&":
            out.append("\\g<0>")
            i += 1
            continue
        if ch == "\\":
            out.append("\\\\")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _parse_sed_script(script: str) -> tuple[str, str, bool, bool]:
    if len(script) < 2 or script[0] != "s":
        raise UnsupportedConstruct("unsupported-flag", "sed: only s/// scripts are supported")
    delim = script[1]
    if not delim or delim.isalnum() or delim == "\\":
        raise UnsupportedConstruct("malformed-syntax", "sed: invalid delimiter")
    parts: list[str] = []
    current: list[str] = []
    i = 2
    n = len(script)
    while i < n:
        ch = script[i]
        if ch == "\\" and i + 1 < n and script[i + 1] == delim:
            current.append(delim)
            i += 2
            continue
        if ch == delim:
            parts.append("".join(current))
            current = []
            i += 1
            if len(parts) == 2:
                break
            continue
        current.append(ch)
        i += 1
    if len(parts) != 2:
        raise UnsupportedConstruct("malformed-syntax", "sed: unterminated s/// script")
    remainder = script[i:]
    global_flag = "g" in remainder
    icase_flag = "i" in remainder
    for c in remainder:
        if c not in "gi":
            raise UnsupportedConstruct("unsupported-flag", f"sed: unsupported flag '{c}'")
    pattern, repl = parts
    return pattern, repl, global_flag, icase_flag


def cmd_sed(ctx: BuiltinContext) -> int:
    args = ctx.argv[1:]
    if not args:
        raise UnsupportedConstruct("unsupported-flag", "sed: SCRIPT operand required")
    for a in args:
        if a.startswith("-") and a != "-":
            raise UnsupportedConstruct("unsupported-flag", f"sed: unsupported flag {a!r}")
    script = args[0]
    files = args[1:]
    pattern, repl, global_flag, icase_flag = _parse_sed_script(script)
    re_flags = re.IGNORECASE if icase_flag else 0
    try:
        compiled = re.compile(pattern, re_flags)
    except re.error as exc:
        raise UnsupportedConstruct("malformed-syntax", f"sed: invalid pattern: {exc}") from exc
    py_repl = _parse_sed_replacement(repl)
    count = 0 if global_flag else 1

    def transform(data: bytes) -> bytes:
        text = data.decode("utf-8", errors="replace")
        if text == "":
            return b""
        had_trailing_newline = text.endswith("\n")
        body = text[:-1] if had_trailing_newline else text
        lines = body.split("\n") if body or had_trailing_newline else [""]
        if body == "" and not had_trailing_newline:
            lines = [""]
        result_lines = [compiled.sub(py_repl, ln, count=count) for ln in lines]
        out = "\n".join(result_lines)
        if had_trailing_newline:
            out += "\n"
        return out.encode("utf-8")

    if not files:
        ctx.stdout.write(transform(ctx.stdin.read()))
        return 0
    for name in files:
        with open(_resolve(ctx.cwd, name), "rb") as fh:
            data = fh.read()
        ctx.stdout.write(transform(data))
    return 0
