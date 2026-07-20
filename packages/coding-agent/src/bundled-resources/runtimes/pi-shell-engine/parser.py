"""Token list -> command AST; raises `UnsupportedConstruct` for banned grammar.

`parse(tokens) -> CommandList` per windows-shell-workpackages-2026-07-19.md §1.4. Never
returns a partial/guessed tree: any construct outside the frozen grammar raises
`UnsupportedConstruct` with the matching catalog id and an actionable message naming the
construct.
"""

from __future__ import annotations

import re

from errors import UnsupportedConstruct
from nodes import (
    AndOr,
    BraceGroup,
    CommandList,
    DQ,
    Lit,
    Pipeline,
    PipelineElement,
    Raw,
    Redirect,
    SimpleCommand,
    Subshell,
    Word,
)
from tokens import Token

_ASSIGNMENT_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.DOTALL)
_EXTGLOB_RE = re.compile(r"[@!?*+]\(")
_BRACE_EXPANSION_RE = re.compile(r"\{[^{}]*,[^{}]*\}")

_JOB_CONTROL_WORDS = {"fg", "bg", "jobs", "wait", "disown"}
_CONTROL_FLOW_WORDS = {"if", "for", "while", "until", "case", "select"}
_ARITHMETIC_WORDS = {"let"}
_UNSUPPORTED_BUILTIN_WORDS = {"eval", "source", ".", "alias", "trap", "set", "shopt", "read", "declare", "local"}
_NESTED_SHELL_WORDS = {"bash", "sh", "zsh", "fish", "cmd", "powershell", "pwsh", "wsl"}


def _literal_text_from_segments(segments: list) -> str | None:
    parts: list[str] = []
    for seg in segments:
        if isinstance(seg, Lit):
            parts.append(seg.text)
        elif isinstance(seg, Raw):
            parts.append(seg.text)
        elif isinstance(seg, DQ):
            inner = _literal_text_from_segments(seg.segments)
            if inner is None:
                return None
            parts.append(inner)
        else:
            return None
    return "".join(parts)


def _literal_text(word: Word) -> str | None:
    return _literal_text_from_segments(word.segments)


def _check_word_banned_patterns(word: Word) -> None:
    for seg in word.segments:
        if isinstance(seg, Raw):
            if _EXTGLOB_RE.search(seg.text):
                raise UnsupportedConstruct(
                    "extended-glob", "Extended glob patterns ('@(...)','!(...)', etc.) are not supported."
                )
            if _BRACE_EXPANSION_RE.search(seg.text):
                raise UnsupportedConstruct(
                    "brace-expansion", "Brace expansion ('{a,b,c}') is not supported; list the values explicitly."
                )


def _check_command_word_banned(text: str) -> None:
    if text in _JOB_CONTROL_WORDS:
        raise UnsupportedConstruct("job-control", f"Job control ('{text}') is not supported.")
    if text in _CONTROL_FLOW_WORDS:
        raise UnsupportedConstruct(
            "control-flow", f"Compound control-flow commands ('{text}') are not supported."
        )
    if text in _ARITHMETIC_WORDS:
        raise UnsupportedConstruct("arithmetic-expansion", f"Arithmetic command '{text}' is not supported.")
    if text == "function":
        raise UnsupportedConstruct("function-definition", "Function definitions are not supported.")
    if text == "exec":
        raise UnsupportedConstruct("exec-builtin", "The 'exec' builtin is not supported.")
    if text in _UNSUPPORTED_BUILTIN_WORDS:
        raise UnsupportedConstruct("unsupported-builtin", f"The '{text}' builtin is not supported.")
    if text in _NESTED_SHELL_WORDS:
        raise UnsupportedConstruct(
            "nested-shell", f"Nesting another shell ('{text}') is not supported; run the command directly."
        )
    if text.endswith(".sh") or text.startswith("/bin/"):
        raise UnsupportedConstruct("posix-script", f"Invoking a script/path directly ('{text}') is not supported.")


_REDIRECT_OP_RE = re.compile(r"^(\d*)(.*)$", re.DOTALL)
_DUP_SUFFIX_RE = re.compile(r"&(\d+)$")


def _is_redirect_op_text(text: str) -> bool:
    return "<" in text or ">" in text


class _Parser:
    def __init__(self, toks: list[Token]) -> None:
        self.toks = toks
        self.i = 0

    def peek(self) -> Token | None:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def peek_at(self, offset: int) -> Token | None:
        j = self.i + offset
        return self.toks[j] if j < len(self.toks) else None

    def advance(self) -> Token:
        tok = self.toks[self.i]
        self.i += 1
        return tok

    def at_op(self, text: str) -> bool:
        tok = self.peek()
        return tok is not None and tok.kind == "OP" and tok.text == text

    def _skip_seps(self) -> None:
        while self.at_op(";") or self.at_op("\n"):
            self.advance()

    def parse_command_list(self, stop_texts: frozenset[str]) -> CommandList:
        entries = []
        separators: list[str] = []
        self._skip_seps()
        while True:
            tok = self.peek()
            if tok is None or (tok.kind == "OP" and tok.text in stop_texts):
                break
            entries.append(self.parse_and_or())
            if self.at_op("&"):
                raise UnsupportedConstruct(
                    "job-control", "Background execution ('&') is not supported; run commands synchronously."
                )
            tok = self.peek()
            if tok is None or (tok.kind == "OP" and tok.text in stop_texts):
                break
            if tok.kind == "OP" and tok.text in (";", "\n"):
                separators.append(self.advance().text)  # type: ignore[arg-type]
                self._skip_seps()
                continue
            raise UnsupportedConstruct(
                "malformed-syntax", f"Unexpected token in command list: {tok!r}."
            )
        return CommandList(entries=entries, separators=separators)

    def parse_and_or(self) -> AndOr:
        pipelines = [self.parse_pipeline()]
        operators: list[str] = []
        while self.at_op("&&") or self.at_op("||"):
            operators.append(self.advance().text)  # type: ignore[arg-type]
            while self.at_op("\n"):
                self.advance()
            pipelines.append(self.parse_pipeline())
        return AndOr(pipelines=pipelines, operators=operators)

    def parse_pipeline(self) -> Pipeline:
        negated = False
        tok = self.peek()
        if tok is not None and tok.kind == "WORD" and _literal_text_from_segments(tok.segments or []) == "!":
            negated = True
            self.advance()
        elements: list[PipelineElement] = [self.parse_pipeline_element()]
        while self.at_op("|"):
            self.advance()
            while self.at_op("\n"):
                self.advance()
            elements.append(self.parse_pipeline_element())
        return Pipeline(elements=elements, negated=negated)

    def parse_pipeline_element(self) -> PipelineElement:
        if self.at_op("("):
            self.advance()
            body = self.parse_command_list(frozenset({")"}))
            if not self.at_op(")"):
                raise UnsupportedConstruct("malformed-syntax", "Unterminated subshell: missing closing ')'.")
            self.advance()
            redirects = self._parse_redirects()
            return Subshell(body=body, redirects=redirects)
        if self.at_op("{"):
            self.advance()
            body = self.parse_command_list(frozenset({"}"}))
            if not self.at_op("}"):
                raise UnsupportedConstruct("malformed-syntax", "Unterminated brace group: missing closing '}'.")
            self.advance()
            redirects = self._parse_redirects()
            return BraceGroup(body=body, redirects=redirects)
        command = self.parse_simple_command()
        if not command.assignments and not command.words and not command.redirects:
            # A fully empty SimpleCommand reached as a pipeline element means a missing
            # command word (e.g. "| foo", "a && ", "a | | b"). Assignment-only (`FOO=1`) and
            # redirect-only (`> file`) commands are valid and never reach here empty.
            raise UnsupportedConstruct(
                "malformed-syntax", "Missing command: a pipeline/list element has no command word."
            )
        return command

    def _parse_redirects(self) -> list[Redirect]:
        redirects: list[Redirect] = []
        while True:
            tok = self.peek()
            if tok is not None and tok.kind == "OP" and tok.text is not None and _is_redirect_op_text(tok.text):
                redirects.append(self._parse_one_redirect())
                continue
            break
        return redirects

    def _parse_one_redirect(self) -> Redirect:
        tok = self.advance()
        text = tok.text or ""
        m = _REDIRECT_OP_RE.match(text)
        assert m is not None
        fd_text, _core = m.group(1), m.group(2)
        fd = int(fd_text) if fd_text else None
        dup_match = _DUP_SUFFIX_RE.search(text)
        dup_fd = int(dup_match.group(1)) if dup_match else None
        target: Word | None = None
        if dup_fd is None:
            target_tok = self.peek()
            if target_tok is None or target_tok.kind != "WORD":
                raise UnsupportedConstruct("malformed-syntax", f"Redirect '{text}' is missing its target.")
            self.advance()
            target = Word(segments=target_tok.segments or [])
        return Redirect(op=text, fd=fd, target=target, dup_fd=dup_fd)

    def parse_simple_command(self) -> SimpleCommand:
        assignments: list[tuple[str, Word]] = []
        words: list[Word] = []
        redirects: list[Redirect] = []
        while True:
            tok = self.peek()
            if tok is None:
                break
            if tok.kind == "OP":
                if tok.text is not None and _is_redirect_op_text(tok.text):
                    redirects.append(self._parse_one_redirect())
                    continue
                break
            word = Word(segments=tok.segments or [])
            if not words:
                lead = word.segments[0] if word.segments else None
                if isinstance(lead, Raw):
                    m = _ASSIGNMENT_RE.match(lead.text)
                    if m:
                        self.advance()
                        name, rest = m.group(1), m.group(2)
                        value_segments = ([Raw(text=rest)] if rest else []) + list(word.segments[1:])
                        assignments.append((name, Word(segments=value_segments)))
                        continue
            _check_word_banned_patterns(word)
            if not words:
                nxt1 = self.peek_at(1)
                nxt2 = self.peek_at(2)
                if (
                    nxt1 is not None
                    and nxt1.kind == "OP"
                    and nxt1.text == "("
                    and nxt2 is not None
                    and nxt2.kind == "OP"
                    and nxt2.text == ")"
                ):
                    raise UnsupportedConstruct("function-definition", "Function definitions are not supported.")
                literal = _literal_text(word)
                if literal is not None:
                    _check_command_word_banned(literal)
            words.append(word)
            self.advance()
        return SimpleCommand(assignments=assignments, words=words, redirects=redirects)


def parse(tokens: list[Token]) -> CommandList:
    parser = _Parser(tokens)
    result = parser.parse_command_list(frozenset())
    if parser.peek() is not None:
        raise UnsupportedConstruct(
            "malformed-syntax", f"Unexpected trailing token: {parser.peek()!r}."
        )
    return result
