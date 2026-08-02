"""One-pass backslash escape decoding with explicit shell-language policies."""

from __future__ import annotations

ANSI_C_ESCAPES = 0
ECHO_ESCAPES = 1
PRINTF_ESCAPES = 2

_SIMPLE_ESCAPES = {
    "\\": "\\",
    "a": "\a",
    "b": "\b",
    "e": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
}


def decode_backslash_escapes(text: str, mode: int) -> tuple[str, bool]:
    r"""Decode one string without rescanning prefixes; bool signals echo's ``\c``."""
    out: list[str] = []
    i = 0
    while i < len(text):
        char = text[i]
        if char != "\\" or i + 1 >= len(text):
            out.append(char)
            i += 1
            continue
        escaped = text[i + 1]
        simple = _SIMPLE_ESCAPES.get(escaped)
        if simple is not None:
            out.append(simple)
            i += 2
            continue
        if escaped == "c":
            if mode == ECHO_ESCAPES:
                return "".join(out), True
            if mode == PRINTF_ESCAPES:
                out.append("\\c")
            i += 2
            continue
        if escaped == "0":
            end = i + 2
            while end < len(text) and end < i + 5 and text[end] in "01234567":
                end += 1
            digits = text[i + 2 : end]
            value = int(digits, 8) if digits else 0
            out.append(chr(value if mode == ANSI_C_ESCAPES else value & 0xFF))
            i = end
            continue
        if escaped == "x":
            end = i + 2
            while end < len(text) and end < i + 4 and text[end] in "0123456789abcdefABCDEF":
                end += 1
            digits = text[i + 2 : end]
            if digits:
                value = int(digits, 16)
                out.append(chr(value if mode == ANSI_C_ESCAPES else value & 0xFF))
            else:
                out.append("x" if mode == ANSI_C_ESCAPES else "\\x")
            i = end
            continue
        if mode != ANSI_C_ESCAPES:
            out.append("\\")
        out.append(escaped)
        i += 2
    return "".join(out), False
