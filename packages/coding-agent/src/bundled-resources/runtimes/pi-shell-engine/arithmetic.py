"""Safe integer-expression parser/evaluator for arithmetic ``for ((...))`` loops.

The evaluator deliberately does not call Python ``eval``. It accepts the integer,
variable, update, assignment, comparison, logical, bitwise, and conditional operators
used by Bash loop headers, then applies signed 64-bit wrapping after arithmetic writes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from state import ShellState

_MASK = (1 << 64) - 1
_SIGN_BIT = 1 << 63
_ASSIGNMENT_OPERATORS = frozenset(
    {"=", "+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="}
)
_TOKEN_RE = re.compile(
    r"\s*(?:"
    r"(?P<number>0[xX][0-9A-Fa-f]+|0[bB][01]+|0[0-7]+|[0-9]+)"
    r"|(?P<variable>\$?[A-Za-z_][A-Za-z0-9_]*)"
    r"|(?P<operator>\*\*|\+\+|--|<<=|>>=|\+=|-=|\*=|/=|%=|&=|\^=|\|="
    r"|\|\||&&|==|!=|<=|>=|<<|>>|[=+\-*/%<>()!~&^|?:,])"
    r")"
)


class ArithmeticError(ValueError):
    """A bounded syntax or runtime failure in a loop arithmetic expression."""


@dataclass(frozen=True)
class _Token:
    kind: str
    text: str


@dataclass(frozen=True)
class _Number:
    value: int


@dataclass(frozen=True)
class _Variable:
    name: str


@dataclass(frozen=True)
class _Unary:
    operator: str
    operand: "_Expression"


@dataclass(frozen=True)
class _Binary:
    operator: str
    left: "_Expression"
    right: "_Expression"


@dataclass(frozen=True)
class _Conditional:
    condition: "_Expression"
    when_true: "_Expression"
    when_false: "_Expression"


@dataclass(frozen=True)
class _Assignment:
    operator: str
    target: _Variable
    value: "_Expression"


@dataclass(frozen=True)
class _Update:
    operator: str
    target: _Variable
    prefix: bool


@dataclass(frozen=True)
class _Sequence:
    expressions: tuple["_Expression", ...]


_Expression = _Number | _Variable | _Unary | _Binary | _Conditional | _Assignment | _Update | _Sequence


def _wrap(value: int) -> int:
    unsigned = value & _MASK
    return unsigned - (1 << 64) if unsigned & _SIGN_BIT else unsigned


def _parse_integer(text: str) -> int:
    if text.lower().startswith(("0x", "0b")):
        return _wrap(int(text, 0))
    if len(text) > 1 and text.startswith("0"):
        return _wrap(int(text, 8))
    return _wrap(int(text, 10))


def _tokenize(source: str) -> list[_Token]:
    tokens: list[_Token] = []
    position = 0
    while position < len(source):
        match = _TOKEN_RE.match(source, position)
        if match is None:
            excerpt = source[position : position + 16]
            raise ArithmeticError(f"unexpected arithmetic token near {excerpt!r}")
        kind = match.lastgroup
        assert kind is not None
        text = match.group(kind)
        if kind == "variable" and text.startswith("$"):
            text = text[1:]
        tokens.append(_Token(kind, text))
        position = match.end()
    tokens.append(_Token("end", ""))
    return tokens


class _Parser:
    def __init__(self, source: str) -> None:
        self.tokens = _tokenize(source)
        self.index = 0

    def current(self) -> _Token:
        return self.tokens[self.index]

    def accept(self, operator: str) -> bool:
        if self.current().kind == "operator" and self.current().text == operator:
            self.index += 1
            return True
        return False

    def require(self, operator: str) -> None:
        if not self.accept(operator):
            raise ArithmeticError(f"expected {operator!r} in arithmetic expression")

    def parse(self) -> _Expression:
        expression = self.parse_sequence()
        if self.current().kind != "end":
            raise ArithmeticError(f"unexpected arithmetic token {self.current().text!r}")
        return expression

    def parse_sequence(self) -> _Expression:
        expressions = [self.parse_assignment()]
        while self.accept(","):
            expressions.append(self.parse_assignment())
        return expressions[0] if len(expressions) == 1 else _Sequence(tuple(expressions))

    def parse_assignment(self) -> _Expression:
        target = self.parse_conditional()
        token = self.current()
        if token.kind != "operator" or token.text not in _ASSIGNMENT_OPERATORS:
            return target
        self.index += 1
        if not isinstance(target, _Variable):
            raise ArithmeticError("the left side of an arithmetic assignment must be a variable")
        return _Assignment(token.text, target, self.parse_assignment())

    def parse_conditional(self) -> _Expression:
        condition = self.parse_logical_or()
        if not self.accept("?"):
            return condition
        when_true = self.parse_sequence()
        self.require(":")
        return _Conditional(condition, when_true, self.parse_assignment())

    def parse_logical_or(self) -> _Expression:
        return self._parse_left_associative(self.parse_logical_and, frozenset({"||"}))

    def parse_logical_and(self) -> _Expression:
        return self._parse_left_associative(self.parse_bitwise_or, frozenset({"&&"}))

    def parse_bitwise_or(self) -> _Expression:
        return self._parse_left_associative(self.parse_bitwise_xor, frozenset({"|"}))

    def parse_bitwise_xor(self) -> _Expression:
        return self._parse_left_associative(self.parse_bitwise_and, frozenset({"^"}))

    def parse_bitwise_and(self) -> _Expression:
        return self._parse_left_associative(self.parse_equality, frozenset({"&"}))

    def parse_equality(self) -> _Expression:
        return self._parse_left_associative(self.parse_relational, frozenset({"==", "!="}))

    def parse_relational(self) -> _Expression:
        return self._parse_left_associative(self.parse_shift, frozenset({"<", "<=", ">", ">="}))

    def parse_shift(self) -> _Expression:
        return self._parse_left_associative(self.parse_additive, frozenset({"<<", ">>"}))

    def parse_additive(self) -> _Expression:
        return self._parse_left_associative(self.parse_multiplicative, frozenset({"+", "-"}))

    def parse_multiplicative(self) -> _Expression:
        return self._parse_left_associative(self.parse_power, frozenset({"*", "/", "%"}))

    def parse_power(self) -> _Expression:
        left = self.parse_unary()
        if self.accept("**"):
            return _Binary("**", left, self.parse_power())
        return left

    def parse_unary(self) -> _Expression:
        token = self.current()
        if token.kind == "operator" and token.text in ("+", "-", "!", "~"):
            self.index += 1
            return _Unary(token.text, self.parse_unary())
        if token.kind == "operator" and token.text in ("++", "--"):
            self.index += 1
            target = self.parse_unary()
            if not isinstance(target, _Variable):
                raise ArithmeticError(f"{token.text} requires a variable")
            return _Update(token.text, target, True)
        return self.parse_postfix()

    def parse_postfix(self) -> _Expression:
        expression = self.parse_primary()
        token = self.current()
        if token.kind == "operator" and token.text in ("++", "--"):
            self.index += 1
            if not isinstance(expression, _Variable):
                raise ArithmeticError(f"{token.text} requires a variable")
            return _Update(token.text, expression, False)
        return expression

    def parse_primary(self) -> _Expression:
        token = self.current()
        if token.kind == "number":
            self.index += 1
            return _Number(_parse_integer(token.text))
        if token.kind == "variable":
            self.index += 1
            return _Variable(token.text)
        if self.accept("("):
            expression = self.parse_sequence()
            self.require(")")
            return expression
        raise ArithmeticError(f"expected an integer, variable, or '('; found {token.text!r}")

    def _parse_left_associative(self, operand_parser, operators: frozenset[str]) -> _Expression:
        expression = operand_parser()
        while self.current().kind == "operator" and self.current().text in operators:
            operator = self.current().text
            self.index += 1
            expression = _Binary(operator, expression, operand_parser())
        return expression


def compile_arithmetic(source: str) -> _Expression | None:
    stripped = source.strip()
    return None if not stripped else _Parser(stripped).parse()


def _variable_value(variable: _Variable, state: ShellState) -> int:
    text = state.env.get(variable.name, "").strip()
    if not text:
        return 0
    try:
        return _parse_integer(text)
    except ValueError:
        return 0


def _set_variable(variable: _Variable, value: int, state: ShellState) -> int:
    wrapped = _wrap(value)
    state.setenv(variable.name, str(wrapped))
    return wrapped


def _divide(left: int, right: int) -> int:
    if right == 0:
        raise ArithmeticError("division by zero")
    quotient = abs(left) // abs(right)
    return -quotient if (left < 0) != (right < 0) else quotient


def _binary(operator: str, left: int, right: int) -> int:
    if operator == "+":
        return _wrap(left + right)
    if operator == "-":
        return _wrap(left - right)
    if operator == "*":
        return _wrap(left * right)
    if operator == "/":
        return _wrap(_divide(left, right))
    if operator == "%":
        return _wrap(left - _divide(left, right) * right)
    if operator == "**":
        if right < 0:
            raise ArithmeticError("negative exponent")
        return _wrap(pow(left & _MASK, right, 1 << 64))
    if operator in ("<<", ">>"):
        if right < 0 or right >= 64:
            raise ArithmeticError("shift count must be between 0 and 63")
        return _wrap(left << right) if operator == "<<" else _wrap(left >> right)
    if operator == "&":
        return _wrap(left & right)
    if operator == "^":
        return _wrap(left ^ right)
    if operator == "|":
        return _wrap(left | right)
    if operator == "==":
        return int(left == right)
    if operator == "!=":
        return int(left != right)
    if operator == "<":
        return int(left < right)
    if operator == "<=":
        return int(left <= right)
    if operator == ">":
        return int(left > right)
    if operator == ">=":
        return int(left >= right)
    raise ArithmeticError(f"unsupported arithmetic operator {operator!r}")


def evaluate_arithmetic(expression: _Expression | None, state: ShellState) -> int:
    if expression is None:
        return 0
    if isinstance(expression, _Number):
        return expression.value
    if isinstance(expression, _Variable):
        return _variable_value(expression, state)
    if isinstance(expression, _Sequence):
        result = 0
        for item in expression.expressions:
            result = evaluate_arithmetic(item, state)
        return result
    if isinstance(expression, _Conditional):
        branch = expression.when_true if evaluate_arithmetic(expression.condition, state) != 0 else expression.when_false
        return evaluate_arithmetic(branch, state)
    if isinstance(expression, _Unary):
        value = evaluate_arithmetic(expression.operand, state)
        if expression.operator == "+":
            return value
        if expression.operator == "-":
            return _wrap(-value)
        if expression.operator == "!":
            return int(value == 0)
        if expression.operator == "~":
            return _wrap(~value)
    if isinstance(expression, _Binary):
        left = evaluate_arithmetic(expression.left, state)
        if expression.operator == "&&":
            return int(left != 0 and evaluate_arithmetic(expression.right, state) != 0)
        if expression.operator == "||":
            return int(left != 0 or evaluate_arithmetic(expression.right, state) != 0)
        return _binary(expression.operator, left, evaluate_arithmetic(expression.right, state))
    if isinstance(expression, _Assignment):
        right = evaluate_arithmetic(expression.value, state)
        if expression.operator == "=":
            return _set_variable(expression.target, right, state)
        left = _variable_value(expression.target, state)
        return _set_variable(expression.target, _binary(expression.operator[:-1], left, right), state)
    if isinstance(expression, _Update):
        old = _variable_value(expression.target, state)
        new = _set_variable(expression.target, old + (1 if expression.operator == "++" else -1), state)
        return new if expression.prefix else old
    raise ArithmeticError("unrecognized arithmetic expression")
