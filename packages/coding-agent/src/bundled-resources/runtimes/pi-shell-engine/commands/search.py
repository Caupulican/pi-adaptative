"""Search/transform builtins: grep, sed.

Pure builtins per windows-shell-workpackages-2026-07-19.md §2.2. Regex dialect is Python
`re` (documented divergence from POSIX BRE/ERE).
"""

from __future__ import annotations

import re
import os
import fnmatch

from context import BuiltinContext
from errors import UnsupportedConstruct
from paths import resolve_request_path

_GREP_FLAGS = set("ivnclwFExhHoqsrRa")
_GREP_VALUE_FLAGS = {"A", "B", "C", "e", "m"}


def _parse_grep_args(args: list[str]) -> tuple[set[str], dict[str, str], list[str], list[str], list[str], list[str]]:
    """Returns (flags, valued, patterns, files, includes, excludes)."""
    flags: set[str] = set()
    valued: dict[str, str] = {}
    patterns: list[str] = []
    includes: list[str] = []
    excludes: list[str] = []
    positional: list[str] = []
    i = 0
    end_of_options = False
    while i < len(args):
        arg = args[i]
        if end_of_options or arg == "-" or not arg.startswith("-"):
            positional.append(arg)
            i += 1
            continue
        if arg == "--":
            end_of_options = True
            i += 1
            continue
        if arg.startswith("--"):
            name, _, value = arg[2:].partition("=")
            if name in ("include", "exclude"):
                if not value:
                    i += 1
                    value = args[i] if i < len(args) else ""
                (includes if name == "include" else excludes).append(value)
            elif name in ("ignore-case",):
                flags.add("i")
            elif name in ("recursive", "dereference-recursive"):
                flags.add("r")
            elif name in ("line-number",):
                flags.add("n")
            elif name in ("count",):
                flags.add("c")
            elif name in ("files-with-matches",):
                flags.add("l")
            elif name in ("invert-match",):
                flags.add("v")
            elif name in ("fixed-strings",):
                flags.add("F")
            elif name in ("extended-regexp",):
                flags.add("E")
            elif name in ("only-matching",):
                flags.add("o")
            elif name in ("quiet", "silent"):
                flags.add("q")
            elif name in ("no-messages",):
                flags.add("s")
            elif name in ("word-regexp",):
                flags.add("w")
            elif name in ("line-regexp",):
                flags.add("x")
            elif name in ("with-filename",):
                flags.add("H")
            elif name in ("no-filename",):
                flags.add("h")
            elif name in ("color", "colour"):
                pass
            elif name in ("regexp",):
                patterns.append(value)
            else:
                raise UnsupportedConstruct("unsupported-flag", f"grep: unsupported flag '--{name}'")
            i += 1
            continue
        chars = arg[1:]
        j = 0
        while j < len(chars):
            char = chars[j]
            if char in _GREP_VALUE_FLAGS:
                value = chars[j + 1 :]
                if not value:
                    i += 1
                    if i >= len(args):
                        raise UnsupportedConstruct("unsupported-flag", f"grep: -{char} requires a value")
                    value = args[i]
                if char == "e":
                    patterns.append(value)
                else:
                    valued[char] = value
                break
            if char.isdigit():
                valued["C"] = chars[j:]
                break
            if char not in _GREP_FLAGS:
                raise UnsupportedConstruct("unsupported-flag", f"grep: unsupported flag '-{char}'")
            flags.add(char)
            j += 1
        i += 1
    if not patterns:
        if not positional:
            raise UnsupportedConstruct("unsupported-flag", "grep: PATTERN operand required")
        patterns.append(positional.pop(0))
    return flags, valued, patterns, positional, includes, excludes


def _context_count(valued: dict[str, str], key: str) -> int:
    raw = valued.get(key, valued.get("C", "0"))
    if not raw.isdigit():
        raise UnsupportedConstruct("unsupported-flag", f"grep: -{key} requires a non-negative integer")
    return int(raw)


def cmd_grep(ctx: BuiltinContext) -> int:
    # Full coreutils surface the sessions used: recursion, context lines, include/exclude globs,
    # only-matching, quiet, whole-line and filename control. Refusing `grep -R` cost turns.
    flags, valued, patterns, files, includes, excludes = _parse_grep_args(ctx.argv[1:])
    ignore_case = "i" in flags
    invert = "v" in flags
    show_lineno = "n" in flags
    count_only = "c" in flags
    files_only = "l" in flags
    whole_word = "w" in flags
    whole_line = "x" in flags
    fixed = "F" in flags
    only_matching = "o" in flags
    quiet = "q" in flags
    suppress_errors = "s" in flags
    recursive = "r" in flags or "R" in flags
    before = _context_count(valued, "B")
    after = _context_count(valued, "A")
    max_count = int(valued["m"]) if valued.get("m", "").isdigit() else None
    re_flags = re.IGNORECASE if ignore_case else 0
    compiled: list["re.Pattern[str]"] = []
    for pattern in patterns:
        source = re.escape(pattern) if fixed else pattern
        if whole_word:
            source = r"(?<!\w)(?:" + source + r")(?!\w)"
        if whole_line:
            source = r"^(?:" + source + r")$"
        try:
            compiled.append(re.compile(source, re_flags))
        except re.error as exc:
            raise UnsupportedConstruct("malformed-syntax", f"grep: invalid pattern: {exc}") from exc

    def find_match(line: str):
        for pattern in compiled:
            found = pattern.search(line)
            if found:
                return found
        return None

    def read_lines(data: bytes) -> list[str]:
        text = data.decode("utf-8", errors="replace")
        if text == "":
            return []
        lines = text.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        return lines

    def expand_files() -> list[str]:
        if not files:
            return []
        expanded: list[str] = []
        for name in files:
            abs_name = resolve_request_path(ctx.cwd, name)
            if os.path.isdir(abs_name):
                if not recursive:
                    expanded.append(name)
                    continue
                for dirpath, dirnames, filenames in os.walk(abs_name):
                    dirnames.sort()
                    for filename in sorted(filenames):
                        if includes and not any(fnmatch.fnmatch(filename, glob) for glob in includes):
                            continue
                        if excludes and any(fnmatch.fnmatch(filename, glob) for glob in excludes):
                            continue
                        rel = os.path.relpath(os.path.join(dirpath, filename), ctx.cwd)
                        display = rel if not rel.startswith("..") else os.path.join(dirpath, filename)
                        expanded.append(display.replace(os.sep, "/"))
            else:
                expanded.append(name)
        return expanded

    targets = expand_files()
    multi_file = ("H" in flags or len(targets) > 1 or (recursive and files)) and "h" not in flags
    any_match = False
    any_error = False
    out_lines: list[str] = []

    def process(name: str, lines: list[str]) -> None:
        nonlocal any_match
        matched_indexes = [index for index, line in enumerate(lines) if (find_match(line) is not None) != invert]
        if max_count is not None:
            matched_indexes = matched_indexes[:max_count]
        if matched_indexes:
            any_match = True
        if quiet:
            return
        if count_only:
            prefix = f"{name}:" if multi_file else ""
            out_lines.append(f"{prefix}{len(matched_indexes)}")
            return
        if files_only:
            if matched_indexes:
                out_lines.append(name)
            return
        matched_set = set(matched_indexes)
        shown: set[int] = set()
        last_shown = -2
        for index in matched_indexes:
            lo = max(0, index - before)
            hi = min(len(lines) - 1, index + after)
            if (before or after) and last_shown >= 0 and lo > last_shown + 1:
                out_lines.append("--")
            for k in range(lo, hi + 1):
                if k in shown:
                    continue
                shown.add(k)
                last_shown = k
                is_match = k in matched_set
                prefix = ""
                if multi_file:
                    prefix += f"{name}{':' if is_match else '-'}"
                if show_lineno:
                    prefix += f"{k + 1}{':' if is_match else '-'}"
                if only_matching and is_match:
                    for pattern in compiled:
                        for found in pattern.finditer(lines[k]):
                            out_lines.append(f"{prefix}{found.group(0)}")
                    continue
                out_lines.append(f"{prefix}{lines[k]}")

    if not targets:
        data = ctx.stdin.read()
        process("(standard input)", read_lines(data))
    else:
        for name in targets:
            abs_name = resolve_request_path(ctx.cwd, name)
            if os.path.isdir(abs_name):
                if not suppress_errors:
                    ctx.stdout.write(f"grep: {name}: Is a directory\n".encode("utf-8"))
                continue
            try:
                with open(abs_name, "rb") as fh:
                    data = fh.read()
            except OSError as exc:
                if not suppress_errors:
                    ctx.stdout.write(f"grep: {name}: {exc.strerror or exc}\n".encode("utf-8"))
                any_error = True
                continue
            process(name, read_lines(data))
    if out_lines:
        ctx.stdout.write(("\n".join(out_lines) + "\n").encode("utf-8"))
    if any_error and not any_match:
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
        with open(resolve_request_path(ctx.cwd, name), "rb") as fh:
            data = fh.read()
        ctx.stdout.write(transform(data))
    return 0
