"""Aggregates every pure builtin into REGISTRY: dict[str, BuiltinFn].

Imports the three WP-D chunks by module name (text, fs, strings, search). WP-D3 authors this
file per the frozen module/function naming in windows-shell-workpackages-2026-07-19.md §3
WP-D; it does not create/stub text.py or fs.py — those land from the sibling WP-D1/WP-D2
chunks in the same wave.
"""

from __future__ import annotations

from context import BuiltinFn

from . import fs, search, strings, text

REGISTRY: dict[str, BuiltinFn] = {
    "echo": strings.cmd_echo,
    "printf": strings.cmd_printf,
    "basename": strings.cmd_basename,
    "dirname": strings.cmd_dirname,
    "which": strings.cmd_which,
    "true": strings.cmd_true,
    "false": strings.cmd_false,
    "pwd": strings.cmd_pwd,
    "test": strings.cmd_test,
    "[": strings.cmd_test,
    "grep": search.cmd_grep,
    "sed": search.cmd_sed,
    "cat": text.cat,
    "head": text.head,
    "tail": text.tail,
    "wc": text.wc,
    "sort": text.sort,
    "uniq": text.uniq,
    "cut": text.cut,
    "tr": text.tr,
    "ls": fs.ls,
    "find": fs.find,
    "rm": fs.rm,
    "cp": fs.cp,
    "mv": fs.mv,
    "mkdir": fs.mkdir,
    "touch": fs.touch,
}
