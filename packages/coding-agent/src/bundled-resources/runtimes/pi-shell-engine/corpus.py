"""The Windows shell corpus tool: harvest, sanitize, evaluate, evolve.

The harness evaluates its own bash contract against the commands models actually wrote, on
this machine or on another one, without ever storing a private command:

- `harvest` reads session transcripts (`*.jsonl`, recursively), takes every `bash` tool call,
  and turns each command into a SHAPE: the grammar (operators, quoting, flags, keywords,
  expansions, path depth and spelling, regex and printf metacharacters) is kept byte for byte,
  every identifier, path component, hostname and literal becomes a synthetic token, and a hard
  leak guard drops any shape that still carries a raw identifier. Each shape records the
  verdict the engine's grammar gives the REAL command (`expect`), so named refusals stay named.
- `replay` runs a fixture through the engine grammar and, for every shape whose command names
  the harness owns (engine builtins, keywords, GNU tools), through the real executor in a
  sandbox with the real GNU tools, and classifies defects: a crash, a refusal for a supported
  family, a harness-owned name lost as "command not found", a traceback, or an expected named
  refusal that stopped being raised.
- `merge` is what `harvest --fixture` does: new shapes are appended with stable ids, known
  shapes only gain count.

Pure stdlib; imports the engine's own tokenizer and parser from this directory.
"""

from __future__ import annotations

import argparse
import collections
import io
import json
import os
import re
import sys
import time
import traceback
from typing import Iterable

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)

from errors import ShellExit, UnsupportedConstruct  # noqa: E402
from parser import parse  # noqa: E402
from tokens import tokenize  # noqa: E402

FIXTURE_DESCRIPTION = (
    "Command shapes derived from real bash-tool sessions; every path, identifier and literal is "
    "synthetic, the grammar is preserved. Every live Windows shell failure adds its shape here "
    "first (see docs/doctrine.md). Regenerate or extend with scripts/windows-shell-corpus.mjs."
)
ROOTS = {
    "windows": "D:/pi-corpus",
    "windowsBackslash": "D:\\pi-corpus",
    "gitBash": "/d/pi-corpus",
    "wsl": "/mnt/d/pi-corpus",
    "programFiles": "C:/Program Files/pi-corpus",
}

KEYWORDS = {
    "for", "do", "done", "if", "then", "else", "elif", "fi", "while", "until", "case", "esac", "in",
    "function", "return", "local", "break", "continue", "exit", "export", "unset", "[[", "]]", "[", "]",
    "!", "true", "false", "shift", "select", "time", "set", "command",
}
TOOLS = {
    "git", "rg", "printf", "ls", "cd", "head", "echo", "find", "gh", "python", "python3", "grep", "cp",
    "wc", "mkdir", "where", "where.exe", "test", "tail", "sort", "rm", "pwd", "which", "node",
    "npm", "npx", "dotnet", "cargo", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
    "sqlcmd", "sqlcmd.exe", "tasklist", "reg", "taskkill", "jscpd", "pip", "uv", "curl", "sed", "awk",
    "xargs", "cat", "mv", "touch", "tr", "cut", "uniq", "diff", "stat", "date", "env", "basename", "dirname",
    "dir", "tree", "type", "seq", "sleep", "tee", "file", "du", "df", "wsl", "wsl.exe", "bash", "sh",
    "make", "msbuild", "msbuild.exe", "dotnet.exe", "code", "notepad", "explorer", "cargo.exe", "rustc",
    "go", "java", "javac", "mvn", "gradle", "ruby", "perl", "php", "composer", "yarn", "pnpm", "deno", "bun",
    "tsc", "vitest", "jest", "eslint", "biome", "prettier", "tar", "unzip", "zip", "7z", "7z.exe", "ssh",
    "scp", "ping", "ipconfig", "netstat", "systeminfo", "wmic", "certutil", "findstr", "more", "sc", "net",
    "start", "call", "sha256sum", "md5sum", "base64", "hexdump", "xxd", "od", "strings", "nl",
    "column", "paste", "rev", "tac", "yes", "nproc", "uname", "whoami", "hostname", "id", "kill", "ps",
    "jq", "yq", "less", "vstest.console.exe", "nuget", "nuget.exe", "msdeploy", "iisreset", "clip",
    "xcopy", "robocopy", "attrib", "icacls", "chcp", "ver", "vol", "mode", "cls", "clear", "realpath",
    "readlink", "cmp", "gawk", "egrep", "fgrep", "pi", "claude",
}
VERBS = {
    "status", "log", "diff", "show", "branch", "checkout", "fetch", "pull", "push", "add", "commit",
    "rev-parse", "ls-files", "ls-tree", "stash", "remote", "tag", "config", "api", "run", "list", "view",
    "pr", "issue", "repo", "head", "main", "master", "origin", "all", "install", "build", "test", "clean",
    "restore", "publish", "pack", "update", "upgrade", "init", "version", "help", "info", "search",
    "query", "get", "set", "delete", "create", "edit", "merge", "rebase", "reset", "revert", "cherry-pick",
    "blame", "describe", "worktree", "submodule", "clone", "mv", "rm", "grep", "bisect", "reflog",
    "shortlog", "format-patch", "apply", "am", "count-objects", "gc", "fsck", "prune", "archive",
    "release", "workflow", "auth", "gist", "secret", "label", "milestone", "project", "cache", "check",
    "checks", "comment", "close", "reopen", "ready", "review", "sync", "fork", "star",
    "unstar", "watch", "unwatch", "download", "upload", "logs", "cancel", "rerun", "enable",
    "disable", "-", "--", "true", "false", "null", "utf8", "utf-8", "ascii", "json", "text", "csv",
    "auto", "always", "never", "none", "on", "off", "yes", "no", "x", "y", "n", "f", "d", "e", "l", "c",
    "type", "name", "path", "size", "date", "time", "count", "number",
    "string", "value", "key", "id", "url", "user", "host", "port", "file", "dir", "line", "lines",
    "word", "words", "char", "chars", "byte", "bytes", "error", "warning", "debug", "trace",
    "fatal", "ok", "done", "fail", "failed", "pass", "passed", "skip", "skipped", "todo", "fixme",
    "x64", "x86", "arm64", "anycpu", "net8.0", "net9.0", "net48", "netstandard2.0",
    "minimal", "normal", "detailed", "diagnostic", "quiet", "verbose", "wait", "nowait", "and", "or", "not",
    "tests", "bin", "obj", "src", "docs", "usr", "home", "tmp", "temp", "users", "public", "windows",
    "system32", "program", "files", "server", "share", "example", "invalid", "comment", "tool", "switch",
    "https", "mnt", "pi",
}
SYNTHETIC_RE = re.compile(r"pi-corpus|program|files|server|share|sp|(p|w|v|flag)\d+", re.I)
SPECIAL_VARS = {
    "HOME", "PATH", "PWD", "OLDPWD", "USERPROFILE", "TEMP", "TMP", "IFS", "RANDOM", "LINENO", "SECONDS",
    "OSTYPE", "SHELL", "USER", "USERNAME", "LANG", "LC_ALL", "PATHEXT", "APPDATA", "LOCALAPPDATA",
    "PROGRAMFILES", "ProgramFiles", "SystemRoot", "COMSPEC", "ComSpec", "SYSTEMROOT",
}

_DRIVE_RE = re.compile(r"^([A-Za-z]):([\\/])")
_POSIX_DRIVE_RE = re.compile(r"^/(mnt/)?([A-Za-z])/")
_URL_RE = re.compile(r"^[a-z][a-z0-9+.-]*://", re.I)
_EMBEDDED_DRIVE_PATH_RE = re.compile("[A-Za-z]:[\\\\/][^\\s'\"|;&]*")
_IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*")
_TEXT_PROTECT_RE = re.compile(
    r"(%[-+ 0#]*\d*(?:\.\d+)?[a-zA-Z]|\[:[a-z]+:\]|\\[ntrsdwSDWbBafvx0])|[0-9]*[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*"
)
_OPERATOR_RE = re.compile(r"\|\||&&|;;&|;;|;&|\|&|>>|<<<|<<-|<<|\d*>&\d*|&>|\d*>|<|[;|&(){}]")


# ---------------------------------------------------------------------------------------------
# Sanitizer
# ---------------------------------------------------------------------------------------------


class Sanitizer:
    """Per-command renaming tables: the same raw identifier maps to the same synthetic token
    within one command, so `$x … $x` and `a.txt … a.txt` keep their relationship."""

    def __init__(self) -> None:
        self.words: dict[str, str] = {}
        self.vars: dict[str, str] = {}
        self.paths: dict[str, str] = {}
        self.counter = 0
        self.var_counter = 0
        self.path_counter = 0

    def word(self, text: str) -> str:
        lower = text.lower()
        if lower in VERBS or lower in TOOLS or lower in KEYWORDS or re.fullmatch(r"[-+]?\d+(\.\d+)?", text):
            return text
        if SYNTHETIC_RE.fullmatch(lower):
            return text
        if text not in self.words:
            self.counter += 1
            self.words[text] = f"w{self.counter}"
        return self.words[text]

    def var(self, name: str) -> str:
        if re.fullmatch(r"[0-9@*#?$!-]", name) or name in SPECIAL_VARS:
            return name
        if name not in self.vars:
            self.var_counter += 1
            self.vars[name] = f"v{self.var_counter}"
        return self.vars[name]

    def component(self, text: str) -> str:
        """One path component: keep globs, dots and the extension; rename the rest."""
        if text in ("", ".", "..", "*", "**", "~"):
            return text
        if re.fullmatch(r"[*?\[\]{}!.,]+", text):
            return text
        stem, dot, ext = text.rpartition(".")
        if not dot or not re.fullmatch(r"[A-Za-z0-9]{1,8}", ext) or stem == "":
            stem, ext, dot = text, "", ""
        parts = re.split(r"([*?\[\]{}]+)", stem)
        renamed = []
        for part in parts:
            if not part or re.fullmatch(r"[*?\[\]{}]+", part):
                renamed.append(part)
                continue
            key = part.lower()
            if key not in self.paths:
                self.path_counter += 1
                marker = (" sp" if " " in part else "") + (" (x)" if "(" in part or ")" in part else "")
                self.paths[key] = f"p{self.path_counter}{marker}"
            renamed.append(self.paths[key])
        return "".join(renamed) + (dot + ext if ext else "")

    def path(self, text: str) -> str:
        if text.startswith("/dev/"):
            return text
        m = _DRIVE_RE.match(text)
        if m:
            sep = m.group(2)
            rest = text[m.end():]
            comps = re.split(r"[\\/]", rest)
            prefix = f"D:{sep}pi-corpus{sep}"
            if rest.lower().startswith("program files"):
                prefix = f"C:{sep}Program Files{sep}pi-corpus{sep}"
                comps = comps[1:]
            return prefix + sep.join(self.component(c) for c in comps)
        m = _POSIX_DRIVE_RE.match(text)
        if m:
            rest = text[m.end():]
            comps = rest.split("/")
            prefix = "/mnt/d/pi-corpus/" if m.group(1) else "/d/pi-corpus/"
            if rest.lower().startswith("program files"):
                prefix = ("/mnt/c/" if m.group(1) else "/c/") + "Program Files/pi-corpus/"
                comps = comps[1:]
            return prefix + "/".join(self.component(c) for c in comps)
        if text.startswith("\\\\"):
            comps = text[2:].split("\\")
            return "\\\\server\\share\\" + "\\".join(self.component(c) for c in comps[2:])
        if text.startswith("~/"):
            return "~/" + "/".join(self.component(c) for c in text[2:].split("/"))
        if text.startswith("/"):
            return "/" + "/".join(self.component(c) for c in text[1:].split("/"))
        pieces = re.split(r"([\\/])", text)
        return "".join(p if p in ("\\", "/") else self.component(p) for p in pieces)

    def pattern(self, text: str) -> str:
        """A glob or regex pattern, an operator argument: identifiers are renamed, every
        metacharacter and separator stays; never read as a path."""

        def repl(m: re.Match) -> str:
            if m.group(1) is not None:
                return m.group(0)
            return self.word(m.group(0))

        return _TEXT_PROTECT_RE.sub(repl, text)

    def value(self, text: str) -> str:
        """An unquoted or quoted value: paths keep their shape, URLs and identifiers are renamed,
        regex, printf and escape metacharacters survive."""
        if text == "":
            return text
        if _URL_RE.match(text):
            return "https://example.invalid/" + "/".join(self.component(c) for c in text.split("/")[3:])
        # A value that IS a path (spaces included, as inside quotes) keeps its whole shape; only
        # then are paths embedded in other text (a SQL literal, a message) rewritten in place.
        if _DRIVE_RE.match(text) or _POSIX_DRIVE_RE.match(text) or text.startswith("\\\\"):
            return self.path(text)
        text = _EMBEDDED_DRIVE_PATH_RE.sub(lambda m: self.path(m.group(0)), text)
        if re.search(r"[\\/]", text) and not re.search(r"\\[nrt0sdwSDWbB.()|+*?\[\]{}^$'\"`]", text):
            return self.path(text)
        return self.pattern(text)


def _matching_close(text: str, open_index: int, opener: str, closer: str) -> int:
    """Index of the `closer` matching the `opener` at `open_index` (the end of the text if unbalanced)."""
    depth = 0
    k = open_index
    while k < len(text):
        if text[k] == opener:
            depth += 1
        elif text[k] == closer:
            depth -= 1
            if depth == 0:
                return k
        k += 1
    return len(text)


def _extract_substitutions(word: str) -> tuple[str, list[str]]:
    """Replace every `$(…)` span with a placeholder; returns (text, spans)."""
    spans: list[str] = []
    out: list[str] = []
    i = 0
    n = len(word)
    quote: str | None = None
    while i < n:
        c = word[i]
        if quote == "'":
            out.append(c)
            if c == "'":
                quote = None
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            out.append(word[i : i + 2])
            i += 2
            continue
        if quote is None and c == "'":
            quote = "'"
            out.append(c)
            i += 1
            continue
        if c == '"':
            quote = None if quote == '"' else '"'
            out.append(c)
            i += 1
            continue
        if word.startswith("$(", i) and not word.startswith("$((", i):
            k = _matching_close(word, i + 1, "(", ")")
            spans.append(word[i + 2 : k])
            out.append(f"\x01{len(spans) - 1}\x01")
            i = k + 1
            continue
        out.append(c)
        i += 1
    return "".join(out), spans


def _escape_unquoted(text: str) -> str:
    """An unquoted word part: a space or parenthesis the sanitizer introduced (a path component
    marker) is escaped exactly as the original escaped its own; expansions keep their parentheses."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text.startswith("$(", i) or text.startswith("${", i):
            closer = ")" if text[i + 1] == "(" else "}"
            depth = 0
            k = i + 1
            while k < n:
                if text[k] == text[i + 1]:
                    depth += 1
                elif text[k] == closer:
                    depth -= 1
                    if depth == 0:
                        break
                k += 1
            out.append(text[i : k + 1])
            i = k + 1
            continue
        if text[i] == "\\" and i + 1 < n:
            out.append(text[i : i + 2])
            i += 2
            continue
        if text[i] in " ()":
            out.append("\\" + text[i])
        else:
            out.append(text[i])
        i += 1
    return "".join(out)


def _requote(word: str, s: Sanitizer) -> str:
    """Sanitize a word while preserving its quote structure."""
    out: list[str] = []
    i = 0
    n = len(word)
    while i < n:
        c = word[i]
        if c == "'":
            k = word.find("'", i + 1)
            k = n if k == -1 else k
            out.append("'" + s.value(word[i + 1 : k]) + "'")
            i = k + 1
            continue
        if c == '"':
            k = i + 1
            while k < n and word[k] != '"':
                k += 2 if word[k] == "\\" else 1
            out.append('"' + s.value(word[i + 1 : k]) + '"')
            i = k + 1
            continue
        k = i
        while k < n and word[k] not in "'\"":
            k += 2 if word[k] == "\\" else 1
        out.append(_escape_unquoted(s.value(word[i:k])))
        i = k
    return "".join(out)


def _sanitize_word_text(word: str, s: Sanitizer, is_command: bool) -> str:
    def expansions(text: str) -> str:
        def sub_param(m: re.Match) -> str:
            return "$" + s.var(m.group(1))

        def sub_brace(m: re.Match) -> str:
            inner = m.group(1)
            nm = re.match(r"([#!]?)([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$-])", inner)
            if not nm:
                return "${" + inner + "}"
            rest = inner[nm.end():]
            head = "${" + nm.group(1) + s.var(nm.group(2))
            op = re.match(r"(:-|:=|:\+|:\?|##|#|%%|%|//|/|\^\^|\^|,,|,|:)(.*)$", rest, re.S)
            if not op:
                return head + sanitize_word(rest, s, False) + "}"
            operator, argument = op.group(1), op.group(2)
            if operator in (":-", ":=", ":+", ":?"):
                return head + operator + s.value(argument) + "}"
            if operator in ("/", "//"):
                pattern_text, slash, replacement = argument.partition("/")
                return head + operator + s.pattern(pattern_text) + slash + s.value(replacement) + "}"
            if operator == ":":
                return head + operator + argument + "}"
            return head + operator + s.pattern(argument) + "}"

        text = re.sub(r"\$\{([^{}]*)\}", sub_brace, text)
        text = re.sub(r"\$([A-Za-z_][A-Za-z0-9_]*)", sub_param, text)
        return text

    if is_command:
        stripped = word.strip("'\"")
        lower = stripped.lower()
        base = re.split(r"[\\/]", stripped)[-1].lower()
        if lower in KEYWORDS or lower in TOOLS:
            return word
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", stripped):
            name, _, value = stripped.partition("=")
            return s.var(name) + "=" + sanitize_word(value, s, False)
        if base in TOOLS and re.search(r"[\\/]", stripped):
            quoted = word[0] if word[:1] in "'\"" else ""
            return quoted + s.path(stripped[: len(stripped) - len(base)]) + base + quoted
        if "$" in word or "`" in word:
            return expansions(word)
        quoted = word[0] if word[:1] in "'\"" else ""
        ext = ""
        m = re.search(r"\.(exe|cmd|bat|ps1|sh|py|js|mjs|cjs)$", lower)
        if m:
            ext = "." + m.group(1)
        if re.search(r"[\\/]", stripped):
            return quoted + s.path(stripped) + quoted
        return quoted + "tool" + ext + quoted
    if re.match(r"^--?[A-Za-z][A-Za-z0-9-]*=", word):
        name, _, value = word.partition("=")
        return name + "=" + sanitize_word(value, s, False)
    attached = re.match(r"^(-[A-Za-z])(['\"].*)$", word)
    if attached:
        return attached.group(1) + _requote(attached.group(2), s)
    if re.match(r"^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$", word):
        # Standard flag spellings stay (short clusters, lowercase long names); a mixed-case switch
        # is a private tool's vocabulary and becomes a numbered flag of the same form.
        if (re.match(r"^-[A-Za-z]{1,3}[0-9]*$", word) and not re.search(r"[A-Z]{2}", word)) or re.match(
            r"^--?[a-z0-9]+(-[a-z0-9]+)*$", word
        ):
            return word
        return ("--" if word.startswith("--") else "-") + "Flag" + s.word(word.lstrip("-") + "\x00flag").lstrip("w")
    if re.match(r"^-{1,2}[A-Za-z0-9]", word) and not re.search(r"[\\/]", word) and "$" not in word:
        return "-" + _requote(word[1:], s)
    if re.match(r"^/[A-Za-z]+(:|$)", word) and ":" in word:
        _name, _, value = word.partition(":")
        return "/switch:" + sanitize_word(value, s, False)
    if "$" in word or "`" in word:
        # Variables first, so `$name` is renamed exactly like its assignment or `for` binding;
        # `${…}` spans are then opaque to the identifier and path passes (their operator text,
        # `##*/`, would otherwise read as a path).
        expanded, spans = _extract_brace_params(expansions(word))
        result = _requote(expanded, s)
        for index, span in enumerate(spans):
            result = result.replace(f"\x02{index}\x02", span)
        return result
    return _requote(word, s)


def _extract_brace_params(text: str) -> tuple[str, list[str]]:
    """Replace every `${…}` span (already sanitized) with a placeholder; returns (text, spans)."""
    spans: list[str] = []
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        if text.startswith("${", i):
            k = _matching_close(text, i + 1, "{", "}")
            spans.append(text[i : k + 1])
            out.append(f"\x02{len(spans) - 1}\x02")
            i = k + 1
            continue
        out.append(text[i])
        i += 1
    return "".join(out), spans


def sanitize_word(word: str, s: Sanitizer, is_command: bool) -> str:
    text, spans = _extract_substitutions(word)
    if spans:
        result = _sanitize_word_text(text, s, is_command)
        for index, span in enumerate(spans):
            result = result.replace(f"\x01{index}\x01", "$(" + sanitize_command(span) + ")")
        return result
    return _sanitize_word_text(word, s, is_command)


def sanitize_command(raw: str) -> str:
    """The shape of one command: grammar kept, identifiers and paths made synthetic."""
    s = Sanitizer()
    out: list[str] = []
    i = 0
    n = len(raw)
    at_command_start = True
    expect_loop_variable = False
    case_depth = 0
    while i < n:
        c = raw[i]
        if c in " \t":
            out.append(c)
            i += 1
            continue
        if c == "\n":
            out.append(c)
            i += 1
            at_command_start = True
            continue
        if c == "#" and (i == 0 or raw[i - 1] in " \t\n;|&"):
            j = raw.find("\n", i)
            j = n if j == -1 else j
            out.append("# comment")
            i = j
            continue
        m = _OPERATOR_RE.match(raw, i)
        if m and not (c == "{" and i + 1 < n and raw[i + 1] not in " \t\n") and not (c == "(" and out and out[-1].endswith("$")):
            text = m.group(0)
            out.append(text)
            i += len(text)
            if text in ("||", "&&", ";", "|", ";;", "(", "{", "|&", ";&", ";;&"):
                at_command_start = True
            continue
        j = i
        while j < n:
            ch = raw[j]
            if ch == "'":
                k = raw.find("'", j + 1)
                j = n if k == -1 else k + 1
                continue
            if ch == '"':
                k = j + 1
                while k < n and raw[k] != '"':
                    k += 2 if raw[k] == "\\" else 1
                j = min(k + 1, n)
                continue
            if ch == "\\":
                j += 2
                continue
            if raw.startswith("$(", j) or raw.startswith("${", j):
                closer = ")" if raw[j + 1] == "(" else "}"
                opener = raw[j + 1]
                depth = 0
                k = j + 1
                while k < n:
                    if raw[k] == opener:
                        depth += 1
                    elif raw[k] == closer:
                        depth -= 1
                        if depth == 0:
                            break
                    k += 1
                j = min(k + 1, n)
                continue
            if ch in " \t\n" or ch in "|&;<>()":
                break
            j += 1
        word = raw[i:j]
        i = j
        if expect_loop_variable:
            # `for NAME in …`: the variable is renamed exactly like its `$NAME` uses.
            out.append(s.var(word) if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", word) else word)
            expect_loop_variable = False
            at_command_start = False
            continue
        if at_command_start and word in ("for", "select"):
            expect_loop_variable = True
        if at_command_start and word == "case":
            case_depth += 1
        elif at_command_start and word == "esac" and case_depth > 0:
            case_depth -= 1
        if case_depth > 0 and at_command_start and raw[j:].lstrip(" \t").startswith(")") and not word.startswith("$("):
            # `pattern)` of a case clause: identifiers inside are renamed, globs and `|` stay.
            out.append(s.pattern(word))
            at_command_start = False
            continue
        out.append(sanitize_word(word, s, at_command_start))
        at_command_start = False
    return "".join(out)


def coarse_sanitize(command: str) -> str:
    """Every quoted string becomes one synthetic token; unquoted words go through the normal rules."""

    def repl(m: re.Match) -> str:
        return m.group(1) + "w" + m.group(1)

    text = re.sub(r"(['\"])(?:\\.|(?!\1).)*\1", repl, command, flags=re.S)
    return sanitize_command(text)


def grammar_verdict(command: str) -> str:
    """`ok`, the construct id the engine's grammar refuses with, or `crash`."""
    try:
        parse(tokenize(command))
        return "ok"
    except UnsupportedConstruct as exc:
        return exc.construct
    except Exception:  # noqa: BLE001
        return "crash"


def refusal_of(command: str) -> dict | None:
    try:
        parse(tokenize(command))
        return None
    except UnsupportedConstruct as exc:
        return {"construct": exc.construct, "message": exc.message}
    except Exception:  # noqa: BLE001
        return {"construct": "crash", "message": "the grammar raised an unexpected exception"}


# An identifier the sanitizer must rename: four or more characters with a letter, standing on its
# own (not a flag name after `-`, not an extension after `.`, not the tail of a longer token).
_PRIVATE_TOKEN_RE = re.compile(r"(?<![-.:\\A-Za-z0-9_])([A-Za-z0-9_]{4,})(?![A-Za-z0-9_])")
# Parts of a dotted or hyphenated public name (`vstest.console.exe`, `cherry-pick`) are public too.
_PUBLIC_PARTS = {part for name in TOOLS | VERBS for part in re.split(r"[.-]", name) if part}


def raw_identifiers(command: str) -> set[str]:
    """Identifier-like tokens of a raw command that must not survive: flag names and file
    extensions are public grammar and stay; everything else outside the public vocabulary is
    private until proven otherwise."""
    found: set[str] = set()
    special = {v.lower() for v in SPECIAL_VARS}
    for token in _PRIVATE_TOKEN_RE.findall(command):
        lower = token.lower()
        if not re.search(r"[A-Za-z]", token):
            continue
        if lower in TOOLS or lower in VERBS or lower in KEYWORDS or lower in special or lower in _PUBLIC_PARTS:
            continue
        if SYNTHETIC_RE.fullmatch(lower):
            continue
        found.add(lower)
    return found


def leak_check(raw: str, sanitized: str) -> list[str]:
    """Raw identifiers that appear verbatim, on their own, in the sanitized shape."""
    survivors = {token.lower() for token in _PRIVATE_TOKEN_RE.findall(sanitized)}
    return sorted(token for token in raw_identifiers(raw) if token in survivors)


def family_of(command: str) -> str:
    m = re.match(r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([^\s'\"|&;(){}]+)", command)
    return m.group(1).lower() if m else "?"


# ---------------------------------------------------------------------------------------------
# Harvest: transcripts -> raw commands -> shapes
# ---------------------------------------------------------------------------------------------


def session_files(targets: Iterable[str]) -> list[str]:
    out: list[str] = []
    for target in targets:
        if os.path.isfile(target):
            out.append(target)
            continue
        for root, dirs, files in os.walk(target):
            dirs.sort()
            for name in sorted(files):
                if name.endswith(".jsonl"):
                    out.append(os.path.join(root, name))
    return out


def platform_of_cwd(cwd: str | None) -> str:
    if isinstance(cwd, str) and re.match(r"^[A-Za-z]:[\\/]|^\\\\", cwd):
        return "win32"
    return "posix"


def harvest_commands(files: Iterable[str], platform: str = "all") -> list[dict]:
    """Every `bash` tool call in the transcripts: `{command, sessionId, platform}`."""
    commands: list[dict] = []
    for path in files:
        session_id = None
        session_platform = "posix"
        try:
            handle = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if entry.get("type") == "session":
                    session_id = entry.get("id")
                    session_platform = platform_of_cwd(entry.get("cwd"))
                    continue
                if entry.get("type") != "message":
                    continue
                message = entry.get("message") or {}
                if message.get("role") != "assistant":
                    continue
                for part in message.get("content") or []:
                    if not isinstance(part, dict) or part.get("type") != "toolCall" or part.get("name") != "bash":
                        continue
                    arguments = part.get("arguments")
                    if isinstance(arguments, str):
                        try:
                            arguments = json.loads(arguments)
                        except ValueError:
                            continue
                    command = (arguments or {}).get("command") if isinstance(arguments, dict) else None
                    if not isinstance(command, str) or not command.strip():
                        continue
                    if platform != "all" and session_platform != platform:
                        continue
                    commands.append({"command": command, "sessionId": session_id, "platform": session_platform})
    return commands


def build_shapes(raw_commands: Iterable[str]) -> tuple[dict[str, dict], dict]:
    """Sanitize every raw command into a shape keyed by its text. A shape is kept only when the
    engine's grammar gives it the same verdict as the real command and no raw identifier
    survives; otherwise the coarse form is tried, then the command is dropped and counted."""
    shapes: dict[str, dict] = {}
    report = collections.Counter()
    for command in raw_commands:
        report["raw"] += 1
        raw_verdict = grammar_verdict(command)
        candidate: str | None = None
        for sanitized in (sanitize_command(command), coarse_sanitize(command)):
            if grammar_verdict(sanitized) != raw_verdict:
                report["verdict-mismatch"] += 1
                continue
            if leak_check(command, sanitized):
                report["leak-blocked"] += 1
                continue
            candidate = sanitized
            break
        if candidate is None:
            report["dropped"] += 1
            continue
        shape = shapes.get(candidate)
        if shape is None:
            expect: object = "ok"
            if raw_verdict != "ok":
                refusal = refusal_of(candidate)
                expect = refusal if refusal is not None else "ok"
            shapes[candidate] = {"family": family_of(candidate), "count": 0, "expect": expect}
            report["shapes"] += 1
        shapes[candidate]["count"] += 1
    return shapes, dict(report)


def merge_fixture(existing: dict | None, shapes: dict[str, dict]) -> tuple[dict, dict]:
    """Known shapes only gain count; new shapes are appended with ids after the highest one."""
    fixture = existing or {"description": FIXTURE_DESCRIPTION, "roots": dict(ROOTS), "shapes": []}
    fixture.setdefault("description", FIXTURE_DESCRIPTION)
    fixture.setdefault("roots", dict(ROOTS))
    rows: list[dict] = fixture.setdefault("shapes", [])
    by_command = {row["command"]: row for row in rows}
    highest = 0
    for row in rows:
        m = re.fullmatch(r"s(\d+)", row.get("id", ""))
        if m:
            highest = max(highest, int(m.group(1)))
    report = collections.Counter()
    for command, meta in sorted(shapes.items(), key=lambda kv: (kv[1]["family"], kv[0])):
        row = by_command.get(command)
        if row is not None:
            row["count"] = int(row.get("count", 0)) + meta["count"]
            report["known"] += 1
            continue
        highest += 1
        rows.append(
            {
                "id": f"s{highest:04d}",
                "family": meta["family"],
                "count": meta["count"],
                "expect": meta["expect"],
                "command": command,
            }
        )
        report["added"] += 1
    return fixture, dict(report)


# ---------------------------------------------------------------------------------------------
# Replay: fixture -> defects
# ---------------------------------------------------------------------------------------------


def sandbox_roots(sandbox: str) -> dict[str, str]:
    """The sandbox spelled the way each fixture root is spelled."""
    forward = sandbox.replace("\\", "/")
    if os.name == "nt" and re.match(r"^[A-Za-z]:/", forward):
        drive = forward[0].lower()
        git_bash = f"/{drive}{forward[2:]}"
        wsl = f"/mnt/{drive}{forward[2:]}"
    else:
        git_bash = forward
        wsl = forward
    return {
        "windows": forward,
        "windowsBackslash": forward.replace("/", "\\"),
        "gitBash": git_bash,
        "wsl": wsl,
        "programFiles": forward + "/Program Files",
    }


def discover_gnu_tools_dir() -> str | None:
    """Where the real GNU tools live for a standalone run: Git for Windows' `usr/bin` next to the
    `git` on PATH (or under Program Files) on Windows, `/usr/bin` elsewhere; `None` when absent."""
    import shutil  # noqa: PLC0415

    marker = ".exe" if os.name == "nt" else ""

    def holds_tools(directory: str) -> bool:
        return all(os.path.isfile(os.path.join(directory, name + marker)) for name in ("ls", "find"))

    if os.name != "nt":
        return "/usr/bin" if holds_tools("/usr/bin") else None
    roots: list[str] = []
    git = shutil.which("git")
    if git:
        directory = os.path.dirname(git)
        for _ in range(3):
            roots.append(directory)
            directory = os.path.dirname(directory)
    roots.extend(os.path.join(base, "Git") for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)")) if base)
    for root in roots:
        candidate = os.path.join(root, "usr", "bin")
        if holds_tools(candidate):
            return candidate
    return None


def _owned_names() -> set[str]:
    import proc  # noqa: PLC0415
    from commands import REGISTRY  # noqa: PLC0415
    from context import RUNNER_BUILTINS, STATE_BUILTINS  # noqa: PLC0415

    keywords = {"for", "do", "done", "if", "then", "else", "elif", "fi", "while", "until", "case", "esac", "in",
                "function", "[[", "]]", "!", "{", "}", "time"}
    return set(REGISTRY) | set(STATE_BUILTINS) | set(RUNNER_BUILTINS) | set(proc.GNU_PREFERRED_TOOLS) | keywords


def _command_names(ast) -> set[str]:
    import nodes  # noqa: PLC0415

    names: set[str] = set()

    def visit_list(lst) -> None:
        for andor in lst.entries:
            for pipeline in andor.pipelines:
                for element in pipeline.elements:
                    visit_element(element)

    def visit_element(element) -> None:
        if isinstance(element, nodes.SimpleCommand):
            if element.words:
                names.add("".join(getattr(seg, "text", "\x00") for seg in element.words[0].segments))
        elif isinstance(element, (nodes.Subshell, nodes.BraceGroup)):
            visit_list(element.body)
        elif isinstance(element, (nodes.ForCommand, nodes.ArithmeticForCommand, nodes.WhileCommand, nodes.UntilCommand)):
            if hasattr(element, "condition"):
                visit_list(element.condition)
            visit_list(element.body)
        elif isinstance(element, nodes.IfCommand):
            for condition, body in element.branches:
                visit_list(condition)
                visit_list(body)
            if element.else_body is not None:
                visit_list(element.else_body)
        elif isinstance(element, nodes.CaseCommand):
            for _patterns, body, _terminator in element.clauses:
                visit_list(body)
        elif isinstance(element, nodes.FunctionDefinition):
            visit_element(element.body)

    visit_list(ast)
    return names


def replay(fixture: dict, sandbox: str, gnu_tools_dir: str | None, per_shape_seconds: float = 10.0) -> list[dict]:
    """Parse every shape; execute every harness-owned shape in `sandbox` with the real GNU tools."""
    import exec as execmod  # noqa: PLC0415
    from commands import REGISTRY  # noqa: PLC0415
    from context import ExecContext  # noqa: PLC0415
    from expand import ParamExpansionError, expand_word  # noqa: PLC0415
    from state import ShellState  # noqa: PLC0415

    owned_names = _owned_names()
    roots = fixture.get("roots") or ROOTS
    spellings = sandbox_roots(sandbox)
    work_root = os.path.join(sandbox, "work")
    os.makedirs(work_root, exist_ok=True)

    def substitute(command: str) -> str:
        for key, root in roots.items():
            command = command.replace(root, spellings.get(key, root))
        return command

    results: list[dict] = []
    for shape in fixture.get("shapes", []):
        entry: dict = {"id": shape["id"]}
        try:
            ast = parse(tokenize(shape["command"]))
        except UnsupportedConstruct as exc:
            entry["refusal"] = {"construct": exc.construct, "message": exc.message}
            results.append(entry)
            continue
        except Exception:  # noqa: BLE001
            entry["crash"] = traceback.format_exc()
            results.append(entry)
            continue
        names = _command_names(ast)
        entry["names"] = sorted(names)
        owned = all(name in owned_names for name in names)
        entry["owned"] = owned
        if not owned:
            results.append(entry)
            continue
        work = os.path.join(work_root, shape["id"])
        os.makedirs(work, exist_ok=True)
        env = {"PATH": os.environ.get("PATH", ""), "PATHEXT": os.environ.get("PATHEXT", ""), "HOME": work, "TEMP": work, "TMP": work}
        for key in ("SYSTEMROOT", "COMSPEC", "WINDIR"):
            if os.environ.get(key):
                env[key] = os.environ[key]
        state = ShellState(cwd=work, env=env, gnu_tools_dir=gnu_tools_dir)
        merged = io.BytesIO()
        ctx = ExecContext(
            state=state,
            stdin=io.BytesIO(),
            stdout=merged,
            expand_word=expand_word,
            run_command_substitution=execmod.run_command_substitution,
            builtins=REGISTRY,
            deadline=time.monotonic() + per_shape_seconds,
            stderr=merged,
        )
        try:
            exit_code = execmod.execute(parse(tokenize(substitute(shape["command"]))), ctx)
        except ShellExit as exc:
            exit_code = exc.exit_code
        except UnsupportedConstruct as exc:
            entry["refusal"] = {"construct": exc.construct, "message": exc.message}
            exit_code = 2
        except ParamExpansionError as exc:
            exit_code = 1
            merged.write(exc.message.encode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            entry["crash"] = traceback.format_exc()
            exit_code = -1
        entry["exitCode"] = exit_code
        entry["output"] = merged.getvalue().decode("utf-8", "replace")[-2000:]
        results.append(entry)
    return results


def classify(fixture: dict, results: list[dict]) -> dict:
    """The wall's verdict over replay results: counts plus every defect with its shape."""
    by_id = {shape["id"]: shape for shape in fixture.get("shapes", [])}
    defects: list[dict] = []
    owned = 0
    refused_by_design = 0
    for entry in results:
        shape = by_id.get(entry["id"])
        if shape is None:
            defects.append({"id": entry["id"], "kind": "unknown-shape", "detail": "replay reported a shape the fixture lacks", "command": ""})
            continue
        expect = shape.get("expect", "ok")
        if entry.get("crash"):
            defects.append({"id": shape["id"], "kind": "crash", "detail": entry["crash"], "command": shape["command"]})
            continue
        if expect != "ok":
            refused_by_design += 1
            got = entry.get("refusal")
            if not got or got.get("construct") != expect.get("construct"):
                detail = f"[{got['construct']}] {got['message']}" if got else "an accepted parse"
                defects.append({
                    "id": shape["id"],
                    "kind": "expected-refusal-changed",
                    "detail": f"expected [{expect.get('construct')}] but got {detail}",
                    "command": shape["command"],
                })
            continue
        if entry.get("refusal"):
            refusal = entry["refusal"]
            defects.append({
                "id": shape["id"],
                "kind": "refusal",
                "detail": f"[{refusal['construct']}] {refusal['message']}",
                "command": shape["command"],
            })
            continue
        if not entry.get("owned"):
            continue
        owned += 1
        output = entry.get("output") or ""
        lost = re.search(r"^([^\s:]+): command not found$", output, re.M)
        if lost:
            defects.append({"id": shape["id"], "kind": "lost-command", "detail": lost.group(0), "command": shape["command"]})
        if "Traceback (most recent call last)" in output:
            defects.append({"id": shape["id"], "kind": "traceback", "detail": output, "command": shape["command"]})
    return {
        "shapes": len(fixture.get("shapes", [])),
        "owned": owned,
        "refusedByDesign": refused_by_design,
        "defects": defects,
    }


# ---------------------------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------------------------


def _load_fixture(path: str | None) -> dict | None:
    if not path or not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path: str, data: object) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent="\t", ensure_ascii=False)
        handle.write("\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="corpus.py", description=__doc__.split("\n", 1)[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    h = sub.add_parser("harvest", help="transcripts -> sanitized shapes, merged into a fixture")
    h.add_argument("--sessions", nargs="+", required=True, help="session directories or .jsonl files")
    h.add_argument("--fixture", help="existing fixture to merge into (read)")
    h.add_argument("--out", required=True, help="fixture to write")
    h.add_argument("--platform", choices=["all", "win32", "posix"], default="all")
    h.add_argument("--report", help="write the harvest report as JSON here")

    r = sub.add_parser("replay", help="parse every shape, execute the harness-owned ones, classify defects")
    r.add_argument("--fixture", required=True)
    r.add_argument("--sandbox", required=True)
    r.add_argument("--gnu-tools-dir", default="auto", help="a directory, 'auto' (discover Git for Windows usr/bin or /usr/bin), or 'off'")
    r.add_argument("--out", required=True, help="write the classification report as JSON here")
    r.add_argument("--results", help="also write every raw replay entry here")

    s = sub.add_parser("stats", help="fixture summary")
    s.add_argument("--fixture", required=True)

    args = ap.parse_args(argv)
    if args.cmd == "harvest":
        files = session_files(args.sessions)
        raw = harvest_commands(files, args.platform)
        shapes, build_report = build_shapes(row["command"] for row in raw)
        fixture, merge_report = merge_fixture(_load_fixture(args.fixture), shapes)
        _write_json(args.out, fixture)
        report = {"files": len(files), **build_report, **merge_report, "total": len(fixture["shapes"])}
        if args.report:
            _write_json(args.report, report)
        print(json.dumps(report))
        return 0
    if args.cmd == "replay":
        fixture = _load_fixture(args.fixture)
        if fixture is None:
            print(f"fixture not found: {args.fixture}", file=sys.stderr)
            return 2
        gnu_tools_dir: str | None
        if args.gnu_tools_dir == "off":
            gnu_tools_dir = None
        elif args.gnu_tools_dir == "auto":
            gnu_tools_dir = discover_gnu_tools_dir()
            if gnu_tools_dir is None:
                print("no GNU tools directory found (Git for Windows usr\\bin, or /usr/bin); pass --gnu-tools-dir <dir>|off", file=sys.stderr)
                return 2
        else:
            gnu_tools_dir = args.gnu_tools_dir
        results = replay(fixture, args.sandbox, gnu_tools_dir)
        report = classify(fixture, results)
        report["gnuToolsDir"] = gnu_tools_dir
        _write_json(args.out, report)
        if args.results:
            _write_json(args.results, results)
        print(json.dumps({key: value for key, value in report.items() if key != "defects"} | {"defects": len(report["defects"])}))
        return 1 if report["defects"] else 0
    fixture = _load_fixture(args.fixture) or {"shapes": []}
    families = collections.Counter(shape["family"] for shape in fixture["shapes"])
    refused = sum(1 for shape in fixture["shapes"] if shape.get("expect") != "ok")
    print(json.dumps({"shapes": len(fixture["shapes"]), "refusedByDesign": refused, "families": families.most_common(20)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
