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

_GREP_FLAGS = set("ivnclwFExhHoqsrRaI")

# GNU grep -I: treat a file as binary (and skip it) when its first 8 KiB contain a NUL
# byte — the same heuristic GNU grep itself uses. Only file targets are checked (not
# `(standard input)`), matching real grep behavior.
_BINARY_SNIFF_BYTES = 8192


def _looks_binary(data: bytes) -> bool:
    return b"\x00" in data[:_BINARY_SNIFF_BYTES]
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
    skip_binary = "I" in flags
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
            if skip_binary and _looks_binary(data):
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


class _SedAddress:
    """One sed address: a 1-based line number, `$` (last line), or a regex."""

    __slots__ = ("line", "last", "regex")

    def __init__(self, line: int | None = None, last: bool = False, regex: "re.Pattern[str] | None" = None):
        self.line = line
        self.last = last
        self.regex = regex

    def matches(self, lineno: int, text: str, is_last: bool) -> bool:
        if self.line is not None:
            return lineno == self.line
        if self.last:
            return is_last
        return self.regex is not None and self.regex.search(text) is not None


class _SedCommand:
    """`p`, `d`, or `s///` with an optional address or address range."""

    __slots__ = ("kind", "addr1", "addr2", "compiled", "replacement", "count", "print_on_sub", "in_range")

    def __init__(self, kind: str, addr1: _SedAddress | None, addr2: _SedAddress | None):
        self.kind = kind
        self.addr1 = addr1
        self.addr2 = addr2
        self.compiled: re.Pattern[str] | None = None
        self.replacement = ""
        self.count = 1
        self.print_on_sub = False
        self.in_range = False

    def selects(self, lineno: int, text: str, is_last: bool) -> bool:
        if self.addr1 is None:
            return True
        if self.addr2 is None:
            return self.addr1.matches(lineno, text, is_last)
        if self.in_range:
            # GNU: a numeric end address at or before the start line closes the range immediately.
            if self.addr2.line is not None and self.addr2.line <= lineno:
                self.in_range = False
                return True
            if self.addr2.matches(lineno, text, is_last):
                self.in_range = False
            return True
        if self.addr1.matches(lineno, text, is_last):
            if self.addr2.line is not None and self.addr2.line <= lineno:
                return True
            self.in_range = not (self.addr2.last and is_last)
            return True
        return False


def _compile_sed_regex(pattern: str, icase: bool) -> re.Pattern[str]:
    # BRE and ERE both compile through Python's `re`: the engine has always treated sed patterns as
    # Python regexes, so `-E` is accepted without changing the grammar.
    try:
        return re.compile(pattern, re.IGNORECASE if icase else 0)
    except re.error as exc:
        raise UnsupportedConstruct("malformed-syntax", f"sed: invalid pattern: {exc}") from exc


def _read_sed_delimited(script: str, i: int, delim: str) -> tuple[str, int]:
    """Read text up to the next unescaped `delim`; returns (text, index after the delimiter)."""
    out: list[str] = []
    n = len(script)
    while i < n:
        ch = script[i]
        if ch == "\\" and i + 1 < n and script[i + 1] == delim:
            out.append(delim)
            i += 2
            continue
        if ch == "\\" and i + 1 < n:
            out.append(ch)
            out.append(script[i + 1])
            i += 2
            continue
        if ch == delim:
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    raise UnsupportedConstruct("malformed-syntax", "sed: unterminated address or s/// script")


def _parse_sed_address(script: str, i: int) -> tuple[_SedAddress | None, int]:
    n = len(script)
    if i >= n:
        return None, i
    ch = script[i]
    if ch.isdigit():
        j = i
        while j < n and script[j].isdigit():
            j += 1
        line = int(script[i:j])
        if line < 1:
            raise UnsupportedConstruct("malformed-syntax", "sed: invalid usage of line address 0")
        return _SedAddress(line=line), j
    if ch == "$":
        return _SedAddress(last=True), i + 1
    if ch == "/" or (ch == "\\" and i + 1 < n):
        delim = "/" if ch == "/" else script[i + 1]
        text, j = _read_sed_delimited(script, i + 1 if ch == "/" else i + 2, delim)
        icase = False
        if j < n and script[j] == "I":
            icase = True
            j += 1
        return _SedAddress(regex=_compile_sed_regex(text, icase)), j
    return None, i


def _parse_sed_commands(script: str) -> list[_SedCommand]:
    commands: list[_SedCommand] = []
    i = 0
    n = len(script)
    while i < n:
        while i < n and script[i] in " \t;\n":
            i += 1
        if i >= n:
            break
        addr1, i = _parse_sed_address(script, i)
        addr2 = None
        if addr1 is not None and i < n and script[i] == ",":
            addr2, i = _parse_sed_address(script, i + 1)
            if addr2 is None:
                raise UnsupportedConstruct("malformed-syntax", "sed: unexpected `,'")
        while i < n and script[i] == " ":
            i += 1
        if i >= n:
            raise UnsupportedConstruct("malformed-syntax", "sed: missing command")
        kind = script[i]
        i += 1
        if kind in ("p", "d"):
            commands.append(_SedCommand(kind, addr1, addr2))
        elif kind == "s":
            if i >= n:
                raise UnsupportedConstruct("malformed-syntax", "sed: unterminated s/// script")
            delim = script[i]
            if delim.isalnum() or delim in "\\\n":
                raise UnsupportedConstruct("malformed-syntax", "sed: invalid delimiter")
            pattern, i = _read_sed_delimited(script, i + 1, delim)
            repl, i = _read_sed_delimited(script, i, delim)
            flags = ""
            while i < n and script[i] not in " ;\n":
                flags += script[i]
                i += 1
            for c in flags:
                if c not in "gip":
                    raise UnsupportedConstruct("unsupported-flag", f"sed: unsupported flag '{c}'")
            command = _SedCommand("s", addr1, addr2)
            command.compiled = _compile_sed_regex(pattern, "i" in flags)
            command.replacement = _parse_sed_replacement(repl)
            command.count = 0 if "g" in flags else 1
            command.print_on_sub = "p" in flags
            commands.append(command)
        else:
            raise UnsupportedConstruct(
                "unsupported-flag", f"sed: unsupported command '{kind}' (supported: p, d, s///)"
            )
        while i < n and script[i] == " ":
            i += 1
        if i < n and script[i] not in ";\n":
            raise UnsupportedConstruct("malformed-syntax", f"sed: unexpected characters after command: {script[i:]!r}")
    if not commands:
        raise UnsupportedConstruct("unsupported-flag", "sed: SCRIPT operand required")
    return commands


def _parse_sed_script(script: str) -> tuple[str, str, bool, bool]:
    """Legacy single-`s///` parser kept for callers that only need the four fields."""
    commands = _parse_sed_commands(script)
    if len(commands) != 1 or commands[0].kind != "s" or commands[0].addr1 is not None:
        raise UnsupportedConstruct("unsupported-flag", "sed: only s/// scripts are supported")
    command = commands[0]
    assert command.compiled is not None
    return command.compiled.pattern, command.replacement, command.count == 0, bool(command.compiled.flags & re.IGNORECASE)


def _parse_sed_argv(args: list[str]) -> tuple[bool, list[str], list[str]]:
    """Return (quiet, scripts, files). `-n`, `-e SCRIPT`, `-E`/`-r`, and `--` are accepted; `-i` and
    every other flag are refused so a file is never rewritten by a builtin the caller thought was
    read-only."""
    quiet = False
    scripts: list[str] = []
    operands: list[str] = []
    i = 0
    n = len(args)
    end_of_flags = False
    while i < n:
        a = args[i]
        if end_of_flags or a == "-" or not a.startswith("-"):
            operands.append(a)
            i += 1
            continue
        if a == "--":
            end_of_flags = True
            i += 1
            continue
        if a in ("--quiet", "--silent"):
            quiet = True
            i += 1
            continue
        if a in ("--regexp-extended",):
            i += 1
            continue
        if a.startswith("--expression="):
            scripts.append(a[len("--expression="):])
            i += 1
            continue
        if a == "--expression" or a == "-e":
            if i + 1 >= n:
                raise UnsupportedConstruct("malformed-syntax", "sed: -e requires a script")
            scripts.append(args[i + 1])
            i += 2
            continue
        if a.startswith("--"):
            raise UnsupportedConstruct("unsupported-flag", f"sed: unsupported flag {a!r}")
        cluster = a[1:]
        j = 0
        consumed_next = False
        while j < len(cluster):
            c = cluster[j]
            if c == "n":
                quiet = True
            elif c in "Er":
                pass
            elif c == "e":
                rest = cluster[j + 1 :]
                if rest:
                    scripts.append(rest)
                elif i + 1 < n:
                    scripts.append(args[i + 1])
                    consumed_next = True
                else:
                    raise UnsupportedConstruct("malformed-syntax", "sed: -e requires a script")
                break
            else:
                raise UnsupportedConstruct("unsupported-flag", f"sed: unsupported flag {'-' + c!r}")
            j += 1
        i += 2 if consumed_next else 1
    if not scripts:
        if not operands:
            raise UnsupportedConstruct("unsupported-flag", "sed: SCRIPT operand required")
        scripts.append(operands.pop(0))
    return quiet, scripts, operands


def cmd_sed(ctx: BuiltinContext) -> int:
    quiet, scripts, files = _parse_sed_argv(ctx.argv[1:])
    commands: list[_SedCommand] = []
    for script in scripts:
        commands.extend(_parse_sed_commands(script))

    def transform(data: bytes) -> bytes:
        text = data.decode("utf-8", errors="replace")
        if text == "":
            return b""
        had_trailing_newline = text.endswith("\n")
        body = text[:-1] if had_trailing_newline else text
        lines = body.split("\n")
        for command in commands:
            command.in_range = False
        emitted: list[str] = []
        last_emitted_is_final_input_line = False
        total = len(lines)
        for index, line in enumerate(lines, start=1):
            is_last = index == total
            pattern_space = line
            deleted = False
            for command in commands:
                if not command.selects(index, pattern_space, is_last):
                    continue
                if command.kind == "d":
                    deleted = True
                    break
                if command.kind == "p":
                    emitted.append(pattern_space)
                    last_emitted_is_final_input_line = is_last
                    continue
                assert command.compiled is not None
                pattern_space, substitutions = command.compiled.subn(
                    command.replacement, pattern_space, count=command.count
                )
                if substitutions and command.print_on_sub:
                    emitted.append(pattern_space)
                    last_emitted_is_final_input_line = is_last
            if not deleted and not quiet:
                emitted.append(pattern_space)
                last_emitted_is_final_input_line = is_last
        if not emitted:
            return b""
        out = "\n".join(emitted)
        if had_trailing_newline or not last_emitted_is_final_input_line:
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
