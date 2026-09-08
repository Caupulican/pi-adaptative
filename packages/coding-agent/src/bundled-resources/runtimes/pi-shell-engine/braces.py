"""Bash brace expansion on one word's source text: `{a,b}`, `{1..5}`, `{a..e}`, `{01..10}`.

Runs before every other expansion, exactly where bash runs it (on the unquoted text of a
word). Quoted braces (`'{a,b}'`, `"{a,b}"`), parameter braces (`${x}`), command
substitutions and `{}` / `{single}` stay literal. Each result string is re-tokenized by
the caller as an ordinary word.
"""

from __future__ import annotations

import re

_NUMERIC_RANGE_RE = re.compile(r"^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$")
_ALPHA_RANGE_RE = re.compile(r"^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$")


def _skip_quoted(text: str, index: int) -> int:
    """`text[index]` opens a quote or escape; return the index just past the closed region."""
    char = text[index]
    n = len(text)
    if char == "\\":
        return min(index + 2, n)
    if char == "'":
        close = text.find("'", index + 1)
        return n if close == -1 else close + 1
    if char == '"':
        cursor = index + 1
        while cursor < n:
            if text[cursor] == "\\":
                cursor += 2
                continue
            if text[cursor] == '"':
                return cursor + 1
            cursor += 1
        return n
    raise AssertionError(char)


def _skip_dollar_group(text: str, index: int) -> int:
    """`text[index]` is `$`; skip a `${…}` or `$(…)` group as opaque text."""
    n = len(text)
    opener = text[index + 1] if index + 1 < n else ""
    if opener not in "{(":
        return index + 1
    closer = "}" if opener == "{" else ")"
    depth = 0
    cursor = index + 1
    while cursor < n:
        char = text[cursor]
        if char in "'\"\\":
            cursor = _skip_quoted(text, cursor)
            continue
        if char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return cursor + 1
        cursor += 1
    return n


def _find_group(text: str, start: int) -> tuple[int, int, list[int]] | None:
    """The first unquoted brace group at or after `start`: (open, close, top-level comma indexes)."""
    n = len(text)
    index = start
    while index < n:
        char = text[index]
        if char in "'\"\\":
            index = _skip_quoted(text, index)
            continue
        if char == "$":
            index = _skip_dollar_group(text, index)
            continue
        if char == "{":
            depth = 0
            commas: list[int] = []
            cursor = index
            while cursor < n:
                inner = text[cursor]
                if inner in "'\"\\":
                    cursor = _skip_quoted(text, cursor)
                    continue
                if inner == "$":
                    cursor = _skip_dollar_group(text, cursor)
                    continue
                if inner == "{":
                    depth += 1
                elif inner == "}":
                    depth -= 1
                    if depth == 0:
                        return index, cursor, commas
                elif inner == "," and depth == 1:
                    commas.append(cursor)
                cursor += 1
            return None
        index += 1
    return None


def _range_alternatives(body: str) -> list[str] | None:
    numeric = _NUMERIC_RANGE_RE.match(body)
    if numeric:
        first, last, step_text = numeric.group(1), numeric.group(2), numeric.group(3)
        start, end = int(first), int(last)
        step = abs(int(step_text)) if step_text else 1
        if step == 0:
            step = 1
        width = 0
        if (first.lstrip("-").startswith("0") and len(first.lstrip("-")) > 1) or (
            last.lstrip("-").startswith("0") and len(last.lstrip("-")) > 1
        ):
            width = max(len(first), len(last))
        values = range(start, end + 1, step) if start <= end else range(start, end - 1, -step)
        return [f"{value:0{width}d}" if width else str(value) for value in values]
    alpha = _ALPHA_RANGE_RE.match(body)
    if alpha:
        start, end = ord(alpha.group(1)), ord(alpha.group(2))
        step = abs(int(alpha.group(3))) if alpha.group(3) else 1
        if step == 0:
            step = 1
        codes = range(start, end + 1, step) if start <= end else range(start, end - 1, -step)
        return [chr(code) for code in codes]
    return None


def brace_expand(text: str) -> list[str]:
    """Expand every unquoted brace group in `text`, left to right, like bash."""
    group = _find_group(text, 0)
    while group is not None:
        open_index, close_index, commas = group
        body = text[open_index + 1 : close_index]
        alternatives: list[str] | None
        if commas:
            cuts = [open_index] + commas + [close_index]
            alternatives = [text[cuts[i] + 1 : cuts[i + 1]] for i in range(len(cuts) - 1)]
        else:
            alternatives = _range_alternatives(body)
        if alternatives is None:
            # `{}` and `{single}` are literal text; keep looking past this group.
            group = _find_group(text, close_index + 1)
            continue
        preamble = text[:open_index]
        postscript = text[close_index + 1 :]
        results: list[str] = []
        for alternative in alternatives:
            for expanded_alternative in brace_expand(alternative):
                for expanded_postscript in brace_expand(postscript):
                    results.append(preamble + expanded_alternative + expanded_postscript)
        return results
    return [text]
