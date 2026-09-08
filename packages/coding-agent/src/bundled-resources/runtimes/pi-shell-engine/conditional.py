"""Test predicates shared by the `test`/`[` builtin and the `[[ … ]]` conditional command.

Pure stdlib. `evaluate_conditional` walks the items the parser collected between `[[` and
`]]` (operand words and the structural operators `!`, `(`, `)`, `&&`, `||`) with bash's
precedence: `!` binds tightest, then `&&`, then `||`; parentheses group. Operands are
expanded by the caller-supplied callback, so this module never imports the expander.
"""

from __future__ import annotations

import fnmatch
import os
import re
from typing import Callable

from errors import UnsupportedConstruct
from nodes import DQ, Lit, Word
from paths import resolve_request_path

PATH_UNARY_OPS = frozenset({"-e", "-a", "-f", "-d", "-r", "-w", "-x", "-s", "-L", "-h", "-p", "-S", "-b", "-c"})
STRING_UNARY_OPS = frozenset({"-n", "-z"})
UNARY_OPS = PATH_UNARY_OPS | STRING_UNARY_OPS
INT_BINARY_OPS = frozenset({"-eq", "-ne", "-lt", "-le", "-gt", "-ge"})
FILE_BINARY_OPS = frozenset({"-nt", "-ot", "-ef"})


def eval_unary(op: str, operand: str, cwd: str) -> bool:
    """One unary test predicate against `operand` (paths resolve against `cwd`)."""
    if op in PATH_UNARY_OPS:
        operand = resolve_request_path(cwd, operand)
    if op in ("-e", "-a"):
        return os.path.exists(operand)
    if op == "-f":
        return os.path.isfile(operand)
    if op == "-d":
        return os.path.isdir(operand)
    if op in ("-L", "-h"):
        return os.path.islink(operand)
    if op == "-r":
        return os.access(operand, os.R_OK)
    if op == "-w":
        return os.access(operand, os.W_OK)
    if op == "-x":
        return os.access(operand, os.X_OK)
    if op == "-s":
        return os.path.exists(operand) and os.path.getsize(operand) > 0
    if op in ("-p", "-S", "-b", "-c"):
        # Named pipes, sockets and device nodes: never true for the files a model works with on Windows.
        return False
    if op == "-n":
        return len(operand) > 0
    if op == "-z":
        return len(operand) == 0
    raise AssertionError(op)


def eval_int_binary(op: str, left: int, right: int) -> bool:
    return {
        "-eq": left == right,
        "-ne": left != right,
        "-lt": left < right,
        "-le": left <= right,
        "-gt": left > right,
        "-ge": left >= right,
    }[op]


def eval_file_binary(op: str, left: str, right: str, cwd: str) -> bool:
    left_path = resolve_request_path(cwd, left)
    right_path = resolve_request_path(cwd, right)
    if op == "-ef":
        try:
            return os.path.samefile(left_path, right_path)
        except OSError:
            return False
    left_exists, right_exists = os.path.exists(left_path), os.path.exists(right_path)
    if op == "-nt":
        return left_exists and (not right_exists or os.path.getmtime(left_path) > os.path.getmtime(right_path))
    return right_exists and (not left_exists or os.path.getmtime(left_path) < os.path.getmtime(right_path))


def _is_quoted(word: Word) -> bool:
    """A right-hand side made only of quoted text compares literally, never as a pattern."""
    return bool(word.segments) and all(isinstance(segment, (Lit, DQ)) for segment in word.segments)


class _ConditionalParser:
    """Recursive descent over `[[ … ]]` items: `or := and ('||' and)*`, `and := term ('&&' term)*`,
    `term := '!' term | '(' or ')' | primary`."""

    def __init__(
        self,
        items: list[Word | str],
        expand: Callable[[Word], str],
        arithmetic: Callable[[str], int],
        cwd: str,
        is_variable_set: Callable[[str], bool],
    ) -> None:
        self.items = items
        self.index = 0
        self.expand = expand
        self.arithmetic = arithmetic
        self.cwd = cwd
        self.is_variable_set = is_variable_set

    def _peek(self) -> Word | str | None:
        return self.items[self.index] if self.index < len(self.items) else None

    def _advance(self) -> Word | str:
        item = self.items[self.index]
        self.index += 1
        return item

    def _text(self, item: Word | str) -> str:
        return item if isinstance(item, str) else self.expand(item)

    def _at_structural(self, *texts: str) -> bool:
        item = self._peek()
        return isinstance(item, str) and item in texts

    def parse(self) -> bool:
        result = self._parse_or()
        if self.index != len(self.items):
            raise UnsupportedConstruct(
                "malformed-syntax", f"[[ ]]: unexpected token {self._text(self.items[self.index])!r}."
            )
        return result

    def _parse_or(self) -> bool:
        result = self._parse_and()
        while self._at_structural("||"):
            self._advance()
            right = self._parse_and()
            result = result or right
        return result

    def _parse_and(self) -> bool:
        result = self._parse_term()
        while self._at_structural("&&"):
            self._advance()
            right = self._parse_term()
            result = result and right
        return result

    def _parse_term(self) -> bool:
        item = self._peek()
        if item is None:
            raise UnsupportedConstruct("malformed-syntax", "[[ ]]: an expression is missing.")
        if isinstance(item, Word) and self._literal(item) == "!":
            self._advance()
            return not self._parse_term()
        if self._at_structural("("):
            self._advance()
            result = self._parse_or()
            if not self._at_structural(")"):
                raise UnsupportedConstruct("malformed-syntax", "[[ ]]: missing closing ')'.")
            self._advance()
            return result
        return self._parse_primary()

    @staticmethod
    def _literal(word: Word) -> str | None:
        texts: list[str] = []
        for segment in word.segments:
            text = getattr(segment, "text", None)
            if not isinstance(text, str):
                return None
            texts.append(text)
        return "".join(texts)

    def _parse_primary(self) -> bool:
        first = self._advance()
        first_literal = self._literal(first) if isinstance(first, Word) else first
        if isinstance(first, Word) and first_literal in UNARY_OPS:
            operand = self._peek()
            if operand is None or isinstance(operand, str):
                raise UnsupportedConstruct("malformed-syntax", f"[[ ]]: {first_literal} needs an operand.")
            self._advance()
            return eval_unary(first_literal, self.expand(operand), self.cwd)
        if isinstance(first, Word) and first_literal == "-v":
            operand = self._peek()
            if operand is None or isinstance(operand, str):
                raise UnsupportedConstruct("malformed-syntax", "[[ ]]: -v needs a variable name.")
            self._advance()
            return self.is_variable_set(self.expand(operand))
        left_text = self._text(first)
        operator = self._peek()
        operator_text = (
            self._literal(operator) if isinstance(operator, Word) else operator if isinstance(operator, str) else None
        )
        if operator_text in ("==", "=", "!="):
            self._advance()
            right = self._peek()
            if right is None or isinstance(right, str):
                raise UnsupportedConstruct("malformed-syntax", f"[[ ]]: {operator_text} needs a right-hand side.")
            self._advance()
            right_text = self.expand(right)
            matched = left_text == right_text if _is_quoted(right) else fnmatch.fnmatchcase(left_text, right_text)
            return matched if operator_text != "!=" else not matched
        if operator_text == "=~":
            self._advance()
            pattern_parts: list[str] = []
            while self._peek() is not None and not self._at_structural("&&", "||", ")"):
                pattern_parts.append(self._text(self._advance()))
            if not pattern_parts:
                raise UnsupportedConstruct("malformed-syntax", "[[ ]]: =~ needs a regular expression.")
            try:
                return re.search("".join(pattern_parts), left_text) is not None
            except re.error as exc:
                raise UnsupportedConstruct("malformed-syntax", f"[[ ]]: invalid regular expression: {exc}.") from exc
        if operator_text in ("<", ">"):
            self._advance()
            right = self._advance()
            right_text = self._text(right)
            return left_text < right_text if operator_text == "<" else left_text > right_text
        if operator_text in INT_BINARY_OPS:
            self._advance()
            right = self._advance()
            return eval_int_binary(operator_text, self.arithmetic(left_text), self.arithmetic(self._text(right)))
        if operator_text in FILE_BINARY_OPS:
            self._advance()
            right = self._advance()
            return eval_file_binary(operator_text, left_text, self._text(right), self.cwd)
        return len(left_text) > 0


def evaluate_conditional(
    items: list[Word | str],
    expand: Callable[[Word], str],
    arithmetic: Callable[[str], int],
    cwd: str,
    is_variable_set: Callable[[str], bool],
) -> bool:
    """Evaluate the items between `[[` and `]]`; raises `UnsupportedConstruct` for a malformed expression."""
    return _ConditionalParser(items, expand, arithmetic, cwd, is_variable_set).parse()
