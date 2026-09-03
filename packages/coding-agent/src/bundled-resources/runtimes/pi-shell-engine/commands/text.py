"""Text/stream builtins: cat, head, tail, wc, sort, uniq, cut, tr.

Pure `BuiltinFn`s per context.py §1.5: read `ctx.stdin` when no file operand,
write to `ctx.stdout`, never touch state. Behavior matches
windows-shell-workpackages-2026-07-19.md §2.2 exactly, including the
documented divergences (wc/uniq -c column widths, ordinal sort).
"""

from __future__ import annotations

import os
import re
from typing import TYPE_CHECKING

from errors import UnsupportedConstruct

if TYPE_CHECKING:
    from context import BuiltinContext


def _read_stdin(ctx: "BuiltinContext") -> bytes:
    return ctx.stdin.read()


def _resolve_path(ctx: "BuiltinContext", path: str) -> str:
    if os.path.isabs(path):
        return path
    return os.path.join(ctx.cwd, path)


def _split_flags_and_operands(
    argv: list[str], flag_chars: str, valued_flags: set[str]
) -> tuple[list[str], list[str]]:
    """Split argv[1:] into (flags-as-single-chars-or-valued, operands).

    Stops flag parsing at `--` or the first non-flag token. Unknown flags are
    left for the caller to reject (returned inside `flags` unresolved is not
    possible here; callers pass only the flag set they accept and this raises
    nothing itself — callers validate).
    """
    flags: list[str] = []
    operands: list[str] = []
    i = 0
    args = argv[1:]
    end_of_flags = False
    while i < len(args):
        a = args[i]
        if end_of_flags:
            operands.append(a)
            i += 1
            continue
        if a == "--":
            end_of_flags = True
            i += 1
            continue
        if a.startswith("-") and a != "-" and len(a) > 1:
            flags.append(a)
            i += 1
            continue
        operands.append(a)
        i += 1
    return flags, operands


def _refuse_flag(name: str, flag: str) -> None:
    raise UnsupportedConstruct(
        "unsupported-flag", f"{name}: unsupported flag or form '{flag}'"
    )


def _parse_simple_flags(
    ctx: "BuiltinContext", name: str, known_flags: set[str], max_operands: int | None
) -> tuple[list[str], list[str]]:
    flags: list[str] = []
    operands: list[str] = []
    for arg in ctx.argv[1:]:
        if arg == "--":
            continue
        if arg.startswith("-") and arg != "-":
            if arg not in known_flags and not all(f"-{ch}" in known_flags for ch in arg[1:]):
                _refuse_flag(name, arg)
            flags.append(arg)
        else:
            operands.append(arg)
    if max_operands is not None and len(operands) > max_operands:
        _refuse_flag(name, "multi-file")
    return flags, operands


def _decode_text_lines(data: bytes) -> list[str]:
    text = data.decode("utf-8", errors="surrogateescape")
    lines = text.split("\n")
    if text.endswith("\n"):
        lines.pop()
    return lines


def _write_text_lines(ctx: "BuiltinContext", lines: list[str]) -> None:
    if not lines:
        return
    ctx.stdout.write("\n".join(lines).encode("utf-8", errors="surrogateescape"))
    ctx.stdout.write(b"\n")


# --- cat ---------------------------------------------------------------------


def cat(ctx: "BuiltinContext") -> int:
    flags, operands = _split_flags_and_operands(ctx.argv, "", set())
    for f in flags:
        _refuse_flag("cat", f)
    if not operands:
        ctx.stdout.write(_read_stdin(ctx))
        return 0
    exit_code = 0
    for operand in operands:
        if operand == "-":
            ctx.stdout.write(_read_stdin(ctx))
            continue
        path = _resolve_path(ctx, operand)
        try:
            with open(path, "rb") as fh:
                ctx.stdout.write(fh.read())
        except OSError as exc:
            ctx.stdout.write(f"cat: {operand}: {exc.strerror or exc}\n".encode())
            exit_code = 1
    return exit_code


# --- head / tail ---------------------------------------------------------------


def _parse_n_flag(name: str, argv: list[str]) -> tuple[int, str, list[str], bool, bool]:
    """Parse `[-n N|-N|-c N] [-q|-v] [FILE...]`. Returns (count, unit, operands, quiet, verbose)."""
    n = 10
    unit = "lines"
    quiet = False
    verbose = False
    operands: list[str] = []
    args = argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--":
            operands.extend(args[i + 1 :])
            break
        if a in ("-n", "-c"):
            unit = "bytes" if a == "-c" else "lines"
            i += 1
            if i >= len(args):
                _refuse_flag(name, a)
            n = _parse_int_operand(name, args[i])
            i += 1
            continue
        if (a.startswith("-n") or a.startswith("-c")) and len(a) > 2 and a[2:].lstrip("-").isdigit():
            unit = "bytes" if a.startswith("-c") else "lines"
            n = _parse_int_operand(name, a[2:])
            i += 1
            continue
        if a in ("-q", "--quiet", "--silent"):
            quiet = True
            i += 1
            continue
        if a in ("-v", "--verbose"):
            verbose = True
            i += 1
            continue
        if len(a) > 1 and a[0] == "-" and a[1:].isdigit():
            n = int(a[1:])
            i += 1
            continue
        if a.startswith("-") and a != "-":
            _refuse_flag(name, a)
        operands.append(a)
        i += 1
    return n, unit, operands, quiet, verbose


def _parse_int_operand(name: str, raw: str) -> int:
    if raw.startswith("+"):
        _refuse_flag(name, f"-n {raw}")
    try:
        return int(raw)
    except ValueError:
        _refuse_flag(name, f"-n {raw}")
    raise AssertionError("unreachable")


def _head_or_tail(ctx: "BuiltinContext", name: str, tail: bool) -> int:
    n, unit, operands, quiet, verbose = _parse_n_flag(name, ctx.argv)
    sources = operands if operands else ["-"]
    headers = (len(sources) > 1 and not quiet) or verbose
    exit_code = 0
    first = True
    for operand in sources:
        try:
            data = _read_operand_or_stdin(ctx, [operand])
        except OSError as exc:
            ctx.stdout.write(f"{name}: cannot open '{operand}' for reading: {exc.strerror}\n".encode())
            exit_code = 1
            continue
        if headers:
            label = "standard input" if operand == "-" else operand
            ctx.stdout.write((("" if first else "\n") + f"==> {label} <==\n").encode())
        first = False
        if unit == "bytes":
            chunk = data[-n:] if tail else data[:n]
            if tail and n <= 0:
                chunk = b""
            ctx.stdout.write(chunk)
            continue
        lines = data.splitlines(keepends=True)
        if tail:
            ctx.stdout.write(b"" if n <= 0 else b"".join(lines[-n:]))
        else:
            ctx.stdout.write(b"".join(lines[:n]))
    return exit_code


def head(ctx: "BuiltinContext") -> int:
    return _head_or_tail(ctx, "head", False)


def tail(ctx: "BuiltinContext") -> int:
    return _head_or_tail(ctx, "tail", True)


def _read_operand_or_stdin(ctx: "BuiltinContext", operands: list[str]) -> bytes:
    if not operands or operands[0] == "-":
        return _read_stdin(ctx)
    path = _resolve_path(ctx, operands[0])
    with open(path, "rb") as fh:
        return fh.read()


# --- wc --------------------------------------------------------------------


def _wc_counts(data: bytes) -> tuple[int, int, int, int]:
    lines = data.count(b"\n")
    words = len(data.split())
    byte_count = len(data)
    try:
        char_count = len(data.decode("utf-8"))
    except UnicodeDecodeError:
        char_count = byte_count
    return lines, words, byte_count, char_count


def wc(ctx: "BuiltinContext") -> int:
    # Coreutils shape in full: several files with a `total` row, combined short flags (`-lc`),
    # and the single-count stdin form. Refusing `wc a b` cost turns in the measured sessions.
    raw_flags, operands = _parse_simple_flags(ctx, "wc", {"-l", "-w", "-c", "-m", "-L"}, None)
    flags: list[str] = []
    for raw in raw_flags:
        for ch in raw[1:]:
            flags.append(f"-{ch}")
    selected_keys = [f for f in ("-l", "-w", "-c", "-m", "-L") if f in flags] or ["-l", "-w", "-c"]

    def counts_of(data: bytes) -> dict[str, int]:
        lines, words, byte_count, char_count = _wc_counts(data)
        longest = max((len(line) for line in data.decode("utf-8", errors="replace").split("\n")), default=0)
        return {"-l": lines, "-w": words, "-c": byte_count, "-m": char_count, "-L": longest}

    rows: list[tuple[dict[str, int], str | None]] = []
    exit_code = 0
    if not operands:
        rows.append((counts_of(_read_stdin(ctx)), None))
    for operand in operands:
        try:
            with open(_resolve_path(ctx, operand), "rb") as fh:
                rows.append((counts_of(fh.read()), operand))
        except OSError as exc:
            ctx.stdout.write(f"wc: {operand}: {exc.strerror}\n".encode())
            exit_code = 1
    if len(rows) > 1:
        total = {key: sum(row[0][key] for row in rows) for key in selected_keys}
        rows.append((total, "total"))
    if len(rows) == 1 and rows[0][1] is None and len(selected_keys) == 1:
        ctx.stdout.write(f"{rows[0][0][selected_keys[0]]}\n".encode())
        return exit_code
    width = max([len(str(row[0][key])) for row in rows for key in selected_keys] + [1])
    width = max(width, 7) if len(rows) > 1 or rows[0][1] is not None or len(selected_keys) > 1 else width
    for counts, label in rows:
        columns = "".join(str(counts[key]).rjust(width) for key in selected_keys)
        ctx.stdout.write((columns + (f" {label}" if label is not None else "") + "\n").encode())
    return exit_code


# --- sort --------------------------------------------------------------------


def sort(ctx: "BuiltinContext") -> int:
    flags, operands = _parse_simple_flags(
        ctx, "sort", {"-r", "-n", "-u", "-f"}, 1
    )

    data = _read_operand_or_stdin(ctx, operands)
    lines = _decode_text_lines(data)

    reverse = "-r" in flags
    numeric = "-n" in flags
    fold = "-f" in flags
    unique = "-u" in flags

    def key_numeric(line: str) -> tuple[float, str]:
        m = re.match(r"\s*[-+]?\d+(\.\d+)?", line)
        value = float(m.group(0)) if m else 0.0
        return (value, line)

    if numeric:
        lines.sort(key=key_numeric, reverse=reverse)
    else:
        key_fn = (lambda line: line.lower()) if fold else (lambda line: line)
        lines.sort(key=key_fn, reverse=reverse)

    if unique:
        deduped: list[str] = []
        seen: set[str] = set()
        for line in lines:
            k = line.lower() if fold else line
            if k not in seen:
                seen.add(k)
                deduped.append(line)
        lines = deduped

    _write_text_lines(ctx, lines)
    return 0


# --- uniq --------------------------------------------------------------------


def uniq(ctx: "BuiltinContext") -> int:
    flags, operands = _parse_simple_flags(
        ctx, "uniq", {"-c", "-d", "-u", "-i"}, 1
    )

    data = _read_operand_or_stdin(ctx, operands)
    lines = _decode_text_lines(data)

    ignore_case = "-i" in flags
    count_flag = "-c" in flags
    dup_only = "-d" in flags
    uniq_only = "-u" in flags

    groups: list[tuple[str, int]] = []
    for line in lines:
        cmp_line = line.lower() if ignore_case else line
        if groups:
            prev_line, prev_count = groups[-1]
            prev_cmp = prev_line.lower() if ignore_case else prev_line
            if cmp_line == prev_cmp:
                groups[-1] = (prev_line, prev_count + 1)
                continue
        groups.append((line, 1))

    if dup_only:
        groups = [g for g in groups if g[1] > 1]
    elif uniq_only:
        groups = [g for g in groups if g[1] == 1]

    if count_flag:
        width = max((len(str(c)) for _, c in groups), default=1)
        width = max(width, 7)
        out_lines = [f"{str(c).rjust(width)} {line}" for line, c in groups]
    else:
        out_lines = [line for line, _ in groups]

    _write_text_lines(ctx, out_lines)
    return 0


# --- cut ---------------------------------------------------------------------


def _parse_list_spec(name: str, spec: str) -> list[tuple[int, int | None]]:
    """Parse a cut LIST: comma-separated N | N-M | N- | -M (1-based)."""
    ranges: list[tuple[int, int | None]] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if part.startswith("-"):
            ranges.append((1, int(part[1:])))
        elif part.endswith("-"):
            ranges.append((int(part[:-1]), None))
        elif "-" in part:
            a, b = part.split("-", 1)
            ranges.append((int(a), int(b)))
        else:
            n = int(part)
            ranges.append((n, n))
    return ranges


def _in_ranges(index: int, ranges: list[tuple[int, int | None]]) -> bool:
    for lo, hi in ranges:
        if hi is None:
            if index >= lo:
                return True
        elif lo <= index <= hi:
            return True
    return False


def cut(ctx: "BuiltinContext") -> int:
    delim = "\t"
    field_spec: str | None = None
    char_spec: str | None = None
    operands: list[str] = []
    args = ctx.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a == "-d":
            i += 1
            if i >= len(args):
                _refuse_flag("cut", "-d")
            delim = args[i]
            i += 1
            continue
        if a.startswith("-d") and len(a) > 2:
            delim = a[2:]
            i += 1
            continue
        if a == "-f":
            i += 1
            if i >= len(args):
                _refuse_flag("cut", "-f")
            field_spec = args[i]
            i += 1
            continue
        if a.startswith("-f") and len(a) > 2:
            field_spec = a[2:]
            i += 1
            continue
        if a == "-c":
            i += 1
            if i >= len(args):
                _refuse_flag("cut", "-c")
            char_spec = args[i]
            i += 1
            continue
        if a.startswith("-c") and len(a) > 2:
            char_spec = a[2:]
            i += 1
            continue
        if a == "--":
            operands.extend(args[i + 1 :])
            break
        if a.startswith("-") and a != "-":
            _refuse_flag("cut", a)
        operands.append(a)
        i += 1

    if (field_spec is None) == (char_spec is None):
        _refuse_flag("cut", "-f/-c required (exactly one)")

    if len(operands) > 1:
        _refuse_flag("cut", "multi-file")

    data = _read_operand_or_stdin(ctx, operands)
    lines = _decode_text_lines(data)

    out_lines: list[str] = []
    if field_spec is not None:
        ranges = _parse_list_spec("cut", field_spec)
        for line in lines:
            parts = line.split(delim)
            selected = [p for idx, p in enumerate(parts, start=1) if _in_ranges(idx, ranges)]
            out_lines.append(delim.join(selected))
    else:
        ranges = _parse_list_spec("cut", char_spec)  # type: ignore[arg-type]
        for line in lines:
            selected_chars = [c for idx, c in enumerate(line, start=1) if _in_ranges(idx, ranges)]
            out_lines.append("".join(selected_chars))

    _write_text_lines(ctx, out_lines)
    return 0


# --- tr --------------------------------------------------------------------

_TR_CLASSES = {
    "upper": "".join(chr(c) for c in range(256) if chr(c).isupper()),
    "lower": "".join(chr(c) for c in range(256) if chr(c).islower()),
    "digit": "0123456789",
    "alpha": "".join(chr(c) for c in range(256) if chr(c).isalpha()),
    "space": " \t\n\r\v\f",
}


def _expand_tr_set(spec: str) -> str:
    result: list[str] = []
    i = 0
    while i < len(spec):
        c = spec[i]
        if c == "[" and spec[i : i + 2] == "[:":
            end = spec.find(":]", i + 2)
            if end != -1:
                cls = spec[i + 2 : end]
                if cls in _TR_CLASSES:
                    result.append(_TR_CLASSES[cls])
                    i = end + 2
                    continue
        if i + 2 < len(spec) and spec[i + 1] == "-" and spec[i + 2] != "":
            start_c, end_c = spec[i], spec[i + 2]
            if ord(start_c) <= ord(end_c):
                result.append("".join(chr(x) for x in range(ord(start_c), ord(end_c) + 1)))
                i += 3
                continue
        result.append(c)
        i += 1
    return "".join(result)


def tr(ctx: "BuiltinContext") -> int:
    flags, operands = _parse_simple_flags(
        ctx, "tr", {"-d", "-s", "-c"}, None
    )

    delete = "-d" in flags
    squeeze = "-s" in flags
    complement = "-c" in flags

    if not operands:
        _refuse_flag("tr", "missing SET1")
    set1_raw = operands[0]
    set2_raw = operands[1] if len(operands) > 1 else None

    if len(operands) > 2:
        _refuse_flag("tr", "too many operands")
    if delete and set2_raw is not None and not squeeze:
        _refuse_flag("tr", "tr -d takes only SET1 (unless combined with -s)")
    if not delete and not squeeze and set2_raw is None:
        _refuse_flag("tr", "SET2 required unless -d or -s")

    set1 = _expand_tr_set(set1_raw)
    set2 = _expand_tr_set(set2_raw) if set2_raw is not None else ""

    if complement:
        all_chars = "".join(chr(c) for c in range(256))
        set1 = "".join(c for c in all_chars if c not in set1)

    data = _read_stdin(ctx)
    text = data.decode("utf-8", errors="surrogateescape")

    if delete:
        deleted = "".join(c for c in text if c not in set1)
        if squeeze and set2_raw is not None:
            result_chars: list[str] = []
            prev: str | None = None
            for c in deleted:
                if c in set2 and c == prev:
                    continue
                result_chars.append(c)
                prev = c if c in set2 else None
            out_text = "".join(result_chars)
        else:
            out_text = deleted
    else:
        if set2:
            pad_char = set2[-1]
            padded_set2 = set2 + pad_char * max(0, len(set1) - len(set2))
            table = str.maketrans(set1, padded_set2[: len(set1)])
        else:
            table = str.maketrans("", "")
        translated = text.translate(table)
        if squeeze:
            result_chars2: list[str] = []
            prev2: str | None = None
            squeeze_set = set2 if set2 else set1
            for c in translated:
                if c in squeeze_set and c == prev2:
                    continue
                result_chars2.append(c)
                prev2 = c if c in squeeze_set else None
            out_text = "".join(result_chars2)
        else:
            out_text = translated

    ctx.stdout.write(out_text.encode("utf-8", errors="surrogateescape"))
    return 0
