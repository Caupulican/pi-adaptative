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
import shutil
from typing import TYPE_CHECKING

from errors import UnsupportedConstruct

if TYPE_CHECKING:
    from context import BuiltinContext


def _resolve(cwd: str, path: str) -> str:
    """Resolve `path` against `cwd` without ever touching process cwd."""
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(cwd, path))


def _to_posix(path: str) -> str:
    return path.replace("\\", "/")


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


def ls(ctx: "BuiltinContext") -> int:
    flags, positional = _split_flags(ctx.argv[1:], {"a", "A", "1", "r"}, "ls")
    if len(positional) > 1:
        if any(os.path.isdir(_resolve(ctx.cwd, p)) for p in positional):
            raise UnsupportedConstruct("unsupported-flag", "ls: only one directory operand is supported")
        ordered = sorted(positional)
        lines = []
        exit_code = 0
        for operand in ordered:
            abs_operand = _resolve(ctx.cwd, operand)
            if os.path.isfile(abs_operand):
                lines.append(operand)
            else:
                lines.append(f"ls: {operand}: No such file or directory")
                exit_code = 1
        ctx.stdout.write("".join(line + "\n" for line in lines).encode())
        return exit_code
    target = positional[0] if positional else "."
    abs_target = _resolve(ctx.cwd, target)
    if not os.path.exists(abs_target):
        ctx.stdout.write(f"ls: cannot access '{target}': No such file or directory\n".encode())
        return 1
    if not os.path.isdir(abs_target):
        ctx.stdout.write(f"ls: cannot access '{target}': Not a directory\n".encode())
        return 1
    show_all = "a" in flags
    almost_all = "A" in flags
    entries: list[str] = []
    if show_all:
        entries.append(".")
        entries.append("..")
    for name in os.listdir(abs_target):
        if name.startswith(".") and not (show_all or almost_all):
            continue
        entries.append(name)
    entries.sort()
    if "r" in flags:
        entries.reverse()
    lines = []
    for name in entries:
        full = os.path.join(abs_target, name)
        suffix = "/" if os.path.isdir(full) else ""
        lines.append(name + suffix)
    ctx.stdout.write("".join(line + "\n" for line in lines).encode())
    return 0


def find(ctx: "BuiltinContext") -> int:
    argv = ctx.argv[1:]
    path: str | None = None
    type_filter: str | None = None
    name_pattern: str | None = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "-type":
            i += 1
            if i >= len(argv) or argv[i] not in ("f", "d"):
                raise UnsupportedConstruct("unsupported-flag", "find: -type requires f or d")
            type_filter = argv[i]
        elif arg == "-name":
            i += 1
            if i >= len(argv):
                raise UnsupportedConstruct("unsupported-flag", "find: -name requires a pattern")
            name_pattern = argv[i]
        elif arg.startswith("-") and arg != "-":
            raise UnsupportedConstruct("unsupported-flag", f"find: unsupported flag {arg}")
        else:
            if path is not None:
                raise UnsupportedConstruct("unsupported-flag", "find: only one path operand is supported")
            path = arg
        i += 1
    if path is None:
        path = "."
    abs_root = _resolve(ctx.cwd, path)
    if not os.path.exists(abs_root):
        ctx.stdout.write(f"find: '{path}': No such file or directory\n".encode())
        return 1
    all_paths = [abs_root]
    for dirpath, dirnames, filenames in os.walk(abs_root):
        for d in dirnames:
            all_paths.append(os.path.join(dirpath, d))
        for f in filenames:
            all_paths.append(os.path.join(dirpath, f))
    results: list[str] = []
    for p in all_paths:
        if type_filter == "f" and not os.path.isfile(p):
            continue
        if type_filter == "d" and not os.path.isdir(p):
            continue
        if name_pattern is not None and not fnmatch.fnmatch(os.path.basename(p), name_pattern):
            continue
        rel = os.path.relpath(p, abs_root)
        display = path if rel == "." else os.path.join(path, rel)
        results.append(_to_posix(display))
    results.sort()
    ctx.stdout.write("".join(r + "\n" for r in results).encode())
    return 0


def rm(ctx: "BuiltinContext") -> int:
    flags, paths = _split_flags(ctx.argv[1:], {"f", "r", "R"}, "rm")
    if not paths:
        ctx.stdout.write(b"rm: missing operand\n")
        return 1
    recursive = "r" in flags or "R" in flags
    force = "f" in flags
    exit_code = 0
    for p in paths:
        abs_p = _resolve(ctx.cwd, p)
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
    abs_src = _resolve(ctx.cwd, src)
    abs_dst = _resolve(ctx.cwd, dst)
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
    abs_src = _resolve(ctx.cwd, src)
    abs_dst = _resolve(ctx.cwd, dst)
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
        abs_d = _resolve(ctx.cwd, d)
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
        abs_f = _resolve(ctx.cwd, f)
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
