"""Filesystem builtins: ls, find, rm, cp, mv, mkdir, touch.

Owned by WP-D2. Pure stdlib; imports only context/errors/nodes (never exec/state/proc).
See windows-shell-workpackages-2026-07-19.md §2.2 (matrix) and §3 (WP-D spec).

Every path operand resolves against `ctx.cwd` (never `os.chdir`, never touches
process-global state). A builtin never mutates `ctx.state` (it has none - only cwd/env
strings on `BuiltinContext`).
"""

from __future__ import annotations

import fnmatch
import os
import time
import subprocess
import stat
import shutil
from typing import TYPE_CHECKING

from errors import UnsupportedConstruct
from paths import resolve_request_path

if TYPE_CHECKING:
    from context import BuiltinContext


def _to_posix(path: str) -> str:
    return path.replace("\\", "/")


def _is_link_or_reparse(path: str) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    if is_junction is not None and is_junction(path):
        return True
    try:
        return bool(getattr(os.lstat(path), "st_reparse_tag", 0))
    except OSError:
        return False


def _directory_identity(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


def _split_flags(argv: list[str], allowed: set[str], name: str) -> tuple[set[str], list[str]]:
    """Parse `-x`/`-xy` short flags plus `--` end-of-options; positional args pass through.

    Raises UnsupportedConstruct("unsupported-flag", ...) for any flag char outside `allowed`.
    """
    flags: set[str] = set()
    positional: list[str] = []
    end_opts = False
    for arg in argv:
        if not end_opts and arg == "--":
            end_opts = True
            continue
        if not end_opts and len(arg) > 1 and arg[0] == "-":
            for ch in arg[1:]:
                if ch not in allowed:
                    raise UnsupportedConstruct("unsupported-flag", f"{name}: unsupported flag -{ch}")
                flags.add(ch)
            continue
        positional.append(arg)
    return flags, positional


def _format_mode(st_mode: int) -> str:
    kind = "d" if stat.S_ISDIR(st_mode) else "l" if stat.S_ISLNK(st_mode) else "-"
    bits = ""
    for who in ("USR", "GRP", "OTH"):
        for perm, ch in (("R", "r"), ("W", "w"), ("X", "x")):
            bits += ch if st_mode & getattr(stat, f"S_I{perm}{who}") else "-"
    return kind + bits


def _human_size(size: int) -> str:
    units = ["", "K", "M", "G", "T"]
    value = float(size)
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{int(value)}{unit}" if value >= 10 or unit == "" else f"{value:.1f}{unit}"
        value /= 1024
    return str(size)


def _long_line(full: str, display: str, human: bool) -> str:
    try:
        st = os.lstat(full)
    except OSError:
        return display
    size = _human_size(st.st_size) if human else str(st.st_size)
    when = time.strftime("%b %d %H:%M", time.localtime(st.st_mtime))
    return f"{_format_mode(st.st_mode)} {st.st_nlink:>2} {size:>8} {when} {display}"


def ls(ctx: "BuiltinContext") -> int:
    # Full coreutils spelling the sessions used: -l long listing, -t/-S ordering, -d the operand
    # itself, -h human sizes, several operands, -R recursion. Refusing `ls -l` cost a turn per call
    # in the measured sessions; the engine now answers every form instead of naming a cap.
    flags, positional = _split_flags(ctx.argv[1:], {"a", "A", "1", "l", "r", "R", "t", "d", "h", "S", "F", "p"}, "ls")
    show_all = "a" in flags
    almost_all = "A" in flags
    recursive = "R" in flags
    long_format = "l" in flags
    human = "h" in flags
    operands = positional if positional else ["."]

    def sort_entries(directory: str, names: list[str]) -> list[str]:
        if "t" in flags:
            names.sort(key=lambda name: -_mtime(os.path.join(directory, name)))
        elif "S" in flags:
            names.sort(key=lambda name: -_size(os.path.join(directory, name)))
        else:
            names.sort()
        if "r" in flags:
            names.reverse()
        return names

    def list_entries(directory: str) -> list[str]:
        entries: list[str] = []
        if show_all:
            entries.extend([".", ".."])
        for name in os.listdir(directory):
            if name.startswith(".") and not (show_all or almost_all):
                continue
            entries.append(name)
        return sort_entries(directory, entries)

    def render_name(full: str, name: str) -> str:
        suffix = "/" if os.path.isdir(full) and ("F" in flags or "p" in flags or not long_format) else ""
        return _long_line(full, name + suffix, human) if long_format else name + suffix

    sections: list[str] = []
    visited_directories: set[str] = set()
    exit_code = 0

    def append_section(directory: str, display_directory: str, with_header: bool) -> None:
        identity = _directory_identity(directory)
        if identity in visited_directories:
            return
        visited_directories.add(identity)
        entries = list_entries(directory)
        lines = [render_name(os.path.join(directory, name), name) for name in entries]
        rendered = "".join(line + "\n" for line in lines)
        sections.append(f"{_to_posix(display_directory)}:\n{rendered}" if with_header else rendered)
        if not recursive:
            return
        for name in entries:
            if name in (".", ".."):
                continue
            full = os.path.join(directory, name)
            if os.path.isdir(full) and not _is_link_or_reparse(full):
                append_section(full, os.path.join(display_directory, name), True)

    file_lines: list[tuple[str, str]] = []
    directories: list[tuple[str, str]] = []
    for operand in operands:
        abs_operand = resolve_request_path(ctx.cwd, operand)
        if not os.path.exists(abs_operand):
            exit_code = 1
            if len(operands) == 1:
                ctx.stdout.write(f"ls: cannot access '{operand}': No such file or directory\n".encode())
            else:
                file_lines.append((operand, f"ls: {operand}: No such file or directory"))
            continue
        if os.path.isdir(abs_operand) and "d" not in flags:
            directories.append((abs_operand, operand))
        else:
            file_lines.append((operand, render_name(abs_operand, operand)))
    if file_lines:
        # File operands (and missing operands among them) list like one directory's entries:
        # ordinal order of the operand, reversed by -r.
        file_lines.sort(key=lambda entry: entry[0])
        if "r" in flags:
            file_lines.reverse()
        sections.append("".join(line + "\n" for _, line in file_lines))
    many = len(directories) + (1 if file_lines else 0) > 1 or recursive
    directories.sort(key=lambda entry: entry[1])
    if "r" in flags:
        directories.reverse()
    for abs_dir, display in directories:
        append_section(abs_dir, display, many)
    # Sections are separated by one blank line, as coreutils prints them.
    ctx.stdout.write("\n".join(sections).encode())
    return exit_code


def _mtime(path: str) -> float:
    try:
        return os.lstat(path).st_mtime
    except OSError:
        return 0.0


def _size(path: str) -> int:
    try:
        return os.lstat(path).st_size
    except OSError:
        return 0


def _parse_size_spec(spec: str) -> tuple[str, int]:
    sign = ""
    if spec and spec[0] in "+-":
        sign, spec = spec[0], spec[1:]
    unit = 512
    if spec and spec[-1] in "ckMGb":
        unit = {"c": 1, "k": 1024, "M": 1024**2, "G": 1024**3, "b": 512}[spec[-1]]
        spec = spec[:-1]
    if not spec.isdigit():
        raise UnsupportedConstruct("unsupported-flag", "find: -size requires a number with an optional unit")
    return sign, int(spec) * unit


class _FindExpr:
    """One predicate/operator token of a find expression (recursive-descent evaluated)."""

    def __init__(self, kind: str, value=None) -> None:
        self.kind = kind
        self.value = value


def _parse_find_expression(tokens: list[str]) -> tuple[list, list]:
    """Return (rpn expression, actions). Predicates: type name iname path ipath newer size empty
    mindepth/maxdepth are global options; actions: print print0 delete exec."""
    output: list = []
    ops: list[str] = []
    actions: list = []
    prec = {"or": 1, "and": 2, "not": 3}
    expect_operand = True
    i = 0

    def push_op(op: str) -> None:
        while ops and ops[-1] != "(" and prec[ops[-1]] >= prec[op] and op != "not":
            output.append(_FindExpr(ops.pop()))
        ops.append(op)

    while i < len(tokens):
        tok = tokens[i]
        if tok in ("-a", "-and"):
            push_op("and")
            expect_operand = True
        elif tok in ("-o", "-or"):
            push_op("or")
            expect_operand = True
        elif tok in ("!", "-not"):
            push_op("not")
            expect_operand = True
        elif tok == "(":
            ops.append("(")
            expect_operand = True
        elif tok == ")":
            while ops and ops[-1] != "(":
                output.append(_FindExpr(ops.pop()))
            if not ops:
                raise UnsupportedConstruct("malformed-syntax", "find: unmatched ')'")
            ops.pop()
            expect_operand = False
        else:
            if not expect_operand:
                push_op("and")
            if tok in ("-type", "-name", "-iname", "-path", "-ipath", "-newer", "-size"):
                i += 1
                if i >= len(tokens):
                    raise UnsupportedConstruct("unsupported-flag", f"find: {tok} requires an argument")
                value = tokens[i]
                if tok == "-type" and value not in ("f", "d", "l"):
                    raise UnsupportedConstruct("unsupported-flag", "find: -type requires f, d or l")
                if tok == "-size":
                    value = _parse_size_spec(value)
                output.append(_FindExpr(tok[1:], value))
            elif tok == "-empty":
                output.append(_FindExpr("empty"))
            elif tok == "-prune":
                output.append(_FindExpr("prune"))
            elif tok in ("-print", "-print0", "-delete"):
                actions.append((tok[1:], None))
                output.append(_FindExpr("true"))
            elif tok == "-printf":
                i += 1
                if i >= len(tokens):
                    raise UnsupportedConstruct("unsupported-flag", "find: -printf requires a format")
                actions.append(("printf", tokens[i]))
                output.append(_FindExpr("true"))
            elif tok in ("-exec", "-execdir"):
                argv: list[str] = []
                i += 1
                while i < len(tokens) and tokens[i] not in (";", "+"):
                    argv.append(tokens[i])
                    i += 1
                if i >= len(tokens):
                    raise UnsupportedConstruct("malformed-syntax", "find: -exec requires a terminating ';' or '+'")
                actions.append(("exec+" if tokens[i] == "+" else "exec", argv))
                output.append(_FindExpr("true"))
            elif tok.startswith("-"):
                raise UnsupportedConstruct("unsupported-flag", f"find: unsupported flag {tok}")
            else:
                raise UnsupportedConstruct("malformed-syntax", f"find: unexpected operand {tok!r} after the expression started")
            expect_operand = False
        i += 1
    while ops:
        op = ops.pop()
        if op == "(":
            raise UnsupportedConstruct("malformed-syntax", "find: unmatched '('")
        output.append(_FindExpr(op))
    return output, actions


def _find_printf(fmt: str, path: str, display: str, depth: int) -> str:
    """The -printf directives the sessions used: %p %f %h %s %d %m %y %T+ %TY %Tm %Td %TH %TM %TS, \\n \\t."""
    try:
        st = os.lstat(path)
    except OSError:
        st = None
    mtime = time.localtime(st.st_mtime) if st else time.localtime(0)
    out: list[str] = []
    i = 0
    while i < len(fmt):
        ch = fmt[i]
        if ch == "\\" and i + 1 < len(fmt):
            nxt = fmt[i + 1]
            out.append({"n": "\n", "t": "\t", "0": "\0", "\\": "\\"}.get(nxt, nxt))
            i += 2
            continue
        if ch == "%" and i + 1 < len(fmt):
            nxt = fmt[i + 1]
            i += 2
            if nxt == "p":
                out.append(display)
            elif nxt == "f":
                out.append(os.path.basename(path.rstrip("/\\")) or display)
            elif nxt == "h":
                out.append(_to_posix(os.path.dirname(display)) or ".")
            elif nxt == "s":
                out.append(str(st.st_size if st else 0))
            elif nxt == "d":
                out.append(str(depth))
            elif nxt == "m":
                out.append(f"{(st.st_mode & 0o7777) if st else 0:o}")
            elif nxt == "y":
                out.append("d" if os.path.isdir(path) else "l" if os.path.islink(path) else "f")
            elif nxt == "T" and i < len(fmt):
                spec = fmt[i]
                i += 1
                if spec == "+":
                    out.append(time.strftime("%Y-%m-%d+%H:%M:%S", mtime) + f".{int((st.st_mtime % 1) * 1e10) if st else 0:010d}")
                else:
                    out.append(time.strftime(f"%{spec}", mtime))
            elif nxt == "%":
                out.append("%")
            else:
                raise UnsupportedConstruct("unsupported-flag", f"find: unsupported -printf directive %{nxt}")
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _eval_find(rpn: list, path: str, root: str, flags: dict | None = None) -> bool:
    stack: list[bool] = []
    name = os.path.basename(path) or path
    for node in rpn:
        kind = node.kind
        if kind == "prune":
            if flags is not None:
                flags["pruned"] = True
            stack.append(True)
        elif kind == "and":
            b, a = stack.pop(), stack.pop()
            stack.append(a and b)
        elif kind == "or":
            b, a = stack.pop(), stack.pop()
            stack.append(a or b)
        elif kind == "not":
            stack.append(not stack.pop())
        elif kind == "true":
            stack.append(True)
        elif kind == "type":
            stack.append(
                (node.value == "f" and os.path.isfile(path) and not os.path.islink(path))
                or (node.value == "d" and os.path.isdir(path) and not os.path.islink(path))
                or (node.value == "l" and os.path.islink(path))
            )
        elif kind in ("name", "iname"):
            pattern = node.value.lower() if kind == "iname" else node.value
            stack.append(fnmatch.fnmatchcase(name.lower() if kind == "iname" else name, pattern))
        elif kind in ("path", "ipath"):
            display = _to_posix(path)
            pattern = node.value.replace("\\", "/")
            if kind == "ipath":
                display, pattern = display.lower(), pattern.lower()
            stack.append(fnmatch.fnmatchcase(display, pattern))
        elif kind == "newer":
            stack.append(_mtime(path) > _mtime(resolve_request_path(root, node.value)))
        elif kind == "size":
            sign, size = node.value
            actual = _size(path)
            stack.append(actual > size if sign == "+" else actual < size if sign == "-" else actual == size)
        elif kind == "empty":
            stack.append((os.path.isfile(path) and _size(path) == 0) or (os.path.isdir(path) and not os.listdir(path)))
        else:
            raise UnsupportedConstruct("unsupported-flag", f"find: unsupported predicate {kind}")
    return all(stack) if stack else True


def find(ctx: "BuiltinContext") -> int:
    argv = ctx.argv[1:]
    paths: list[str] = []
    i = 0
    while i < len(argv) and not argv[i].startswith("-") and argv[i] not in ("(", "!"):
        paths.append(argv[i])
        i += 1
    rest = argv[i:]
    mindepth = 0
    maxdepth: int | None = None
    expression_tokens: list[str] = []
    j = 0
    while j < len(rest):
        tok = rest[j]
        if tok in ("-maxdepth", "-mindepth"):
            j += 1
            if j >= len(rest) or not rest[j].isdigit():
                raise UnsupportedConstruct("unsupported-flag", f"find: {tok} requires a non-negative integer")
            if tok == "-maxdepth":
                maxdepth = int(rest[j])
            else:
                mindepth = int(rest[j])
        else:
            expression_tokens.append(tok)
        j += 1
    rpn, actions = _parse_find_expression(expression_tokens)
    if not actions:
        actions = [("print", None)]
    if not paths:
        paths = ["."]
    exit_code = 0
    out: list[bytes] = []
    exec_batches: dict[int, list[str]] = {}
    for start in paths:
        abs_root = resolve_request_path(ctx.cwd, start)
        if not os.path.exists(abs_root):
            ctx.stdout.write(f"find: '{start}': No such file or directory\n".encode())
            exit_code = 1
            continue
        selected: list[tuple[str, str, int]] = []

        def consider(p: str, depth: int) -> bool:
            """Evaluate one entry; returns True when a directory must not be descended (-prune)."""
            eval_flags: dict = {}
            matched = _eval_find(rpn, p, ctx.cwd, eval_flags) if depth >= mindepth else False
            if depth < mindepth:
                _eval_find(rpn, p, ctx.cwd, eval_flags)
            if matched and not (maxdepth is not None and depth > maxdepth):
                rel = os.path.relpath(p, abs_root)
                display = start if rel == "." else os.path.join(start, rel)
                selected.append((_to_posix(display), p, depth))
            return eval_flags.get("pruned", False)

        root_pruned = consider(abs_root, 0)
        if os.path.isdir(abs_root) and not root_pruned:
            for dirpath, dirnames, filenames in os.walk(abs_root):
                depth = 0 if dirpath == abs_root else len(os.path.relpath(dirpath, abs_root).split(os.sep))
                dirnames.sort()
                keep: list[str] = []
                for d in dirnames:
                    pruned = consider(os.path.join(dirpath, d), depth + 1)
                    if not pruned and not (maxdepth is not None and depth + 1 >= maxdepth):
                        keep.append(d)
                dirnames[:] = keep
                for f in sorted(filenames):
                    consider(os.path.join(dirpath, f), depth + 1)
        # Ordinal order of the displayed path, the deterministic order the contract promises.
        selected.sort()
        for display, p, depth in selected:
            for index, (action, argv_template) in enumerate(actions):
                if action == "print":
                    out.append(display.encode() + b"\n")
                elif action == "print0":
                    out.append(display.encode() + b"\0")
                elif action == "printf":
                    out.append(_find_printf(argv_template, p, display, depth).encode())
                elif action == "delete":
                    try:
                        if os.path.isdir(p) and not os.path.islink(p):
                            os.rmdir(p)
                        else:
                            os.remove(p)
                    except OSError as exc:
                        out.append(f"find: cannot delete '{display}': {exc.strerror}\n".encode())
                        exit_code = 1
                elif action == "exec":
                    command = [display if a == "{}" else a.replace("{}", display) for a in argv_template]
                    result = subprocess.run(command, cwd=ctx.cwd, capture_output=True)
                    out.append(result.stdout)
                    if result.returncode != 0:
                        out.append(result.stderr)
                elif action == "exec+":
                    exec_batches.setdefault(index, []).append(display)
    for index, files in exec_batches.items():
        argv_template = actions[index][1]
        command = [a for a in argv_template if a != "{}"] + files
        result = subprocess.run(command, cwd=ctx.cwd, capture_output=True)
        out.append(result.stdout)
        if result.returncode != 0:
            out.append(result.stderr)
            exit_code = exit_code or result.returncode
    ctx.stdout.write(b"".join(out))
    return exit_code


def rm(ctx: "BuiltinContext") -> int:
    flags, paths = _split_flags(ctx.argv[1:], {"f", "r", "R"}, "rm")
    if not paths:
        ctx.stdout.write(b"rm: missing operand\n")
        return 1
    recursive = "r" in flags or "R" in flags
    force = "f" in flags
    exit_code = 0
    for p in paths:
        abs_p = resolve_request_path(ctx.cwd, p)
        if not os.path.lexists(abs_p):
            if not force:
                ctx.stdout.write(f"rm: cannot remove '{p}': No such file or directory\n".encode())
                exit_code = 1
            continue
        if os.path.isdir(abs_p) and not os.path.islink(abs_p):
            if not recursive:
                ctx.stdout.write(f"rm: cannot remove '{p}': Is a directory\n".encode())
                exit_code = 1
                continue
            shutil.rmtree(abs_p)
        else:
            os.remove(abs_p)
    return exit_code


def cp(ctx: "BuiltinContext") -> int:
    flags, positional = _split_flags(ctx.argv[1:], {"r", "R"}, "cp")
    if len(positional) != 2:
        ctx.stdout.write(b"cp: missing file operand\n")
        return 1
    recursive = "r" in flags or "R" in flags
    src, dst = positional
    abs_src = resolve_request_path(ctx.cwd, src)
    abs_dst = resolve_request_path(ctx.cwd, dst)
    if not os.path.exists(abs_src):
        ctx.stdout.write(f"cp: cannot stat '{src}': No such file or directory\n".encode())
        return 1
    if os.path.isdir(abs_src):
        if not recursive:
            ctx.stdout.write(f"cp: -r not specified; omitting directory '{src}' (use -r)\n".encode())
            return 1
        dest = abs_dst
        if os.path.isdir(abs_dst):
            dest = os.path.join(abs_dst, os.path.basename(os.path.normpath(abs_src)))
        shutil.copytree(abs_src, dest, dirs_exist_ok=True)
    else:
        dest = abs_dst
        if os.path.isdir(abs_dst):
            dest = os.path.join(abs_dst, os.path.basename(abs_src))
        shutil.copy2(abs_src, dest)
    return 0


def mv(ctx: "BuiltinContext") -> int:
    _flags, positional = _split_flags(ctx.argv[1:], set(), "mv")
    if len(positional) != 2:
        ctx.stdout.write(b"mv: missing file operand\n")
        return 1
    src, dst = positional
    abs_src = resolve_request_path(ctx.cwd, src)
    abs_dst = resolve_request_path(ctx.cwd, dst)
    if not os.path.exists(abs_src):
        ctx.stdout.write(f"mv: cannot stat '{src}': No such file or directory\n".encode())
        return 1
    dest = abs_dst
    if os.path.isdir(abs_dst):
        dest = os.path.join(abs_dst, os.path.basename(os.path.normpath(abs_src)))
    shutil.move(abs_src, dest)
    return 0


def mkdir(ctx: "BuiltinContext") -> int:
    flags, dirs = _split_flags(ctx.argv[1:], {"p"}, "mkdir")
    if not dirs:
        ctx.stdout.write(b"mkdir: missing operand\n")
        return 1
    parents = "p" in flags
    exit_code = 0
    for d in dirs:
        abs_d = resolve_request_path(ctx.cwd, d)
        if parents:
            os.makedirs(abs_d, exist_ok=True)
            continue
        if os.path.exists(abs_d):
            ctx.stdout.write(f"mkdir: cannot create directory '{d}': File exists\n".encode())
            exit_code = 1
            continue
        try:
            os.mkdir(abs_d)
        except FileNotFoundError:
            ctx.stdout.write(f"mkdir: cannot create directory '{d}': No such file or directory\n".encode())
            exit_code = 1
    return exit_code


def touch(ctx: "BuiltinContext") -> int:
    _flags, files = _split_flags(ctx.argv[1:], set(), "touch")
    if not files:
        ctx.stdout.write(b"touch: missing file operand\n")
        return 1
    exit_code = 0
    for f in files:
        abs_f = resolve_request_path(ctx.cwd, f)
        if os.path.exists(abs_f):
            os.utime(abs_f, None)
            continue
        parent = os.path.dirname(abs_f)
        if parent and not os.path.isdir(parent):
            ctx.stdout.write(f"touch: cannot touch '{f}': No such file or directory\n".encode())
            exit_code = 1
            continue
        open(abs_f, "ab").close()
    return exit_code
