"""Tokenizer: source `str` -> `list[Token]`; resolves quoting into word segments.

Splits Bash source into WORD tokens (each carrying an ordered `list[Segment]` already
broken by quoting/expansion markers) and OPERATOR tokens (the fixed lexeme set from
windows-shell-workpackages-2026-07-19.md §1.1/§3 WP-A). Never returns a partial or
guessed token stream: anything outside the frozen grammar raises `UnsupportedConstruct`
with a catalog id and an actionable message naming the construct.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from errors import UnsupportedConstruct
from nodes import CmdSub, DQ, Lit, Param, Raw, Segment, Tilde, Word

_IDENT_START_RE = re.compile(r"[A-Za-z_]")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_ANSI_C_MAP = {
    "\\": "\\",
    "a": "\a",
    "b": "\b",
    "c": "",  # \c stops output; treated as empty here (bounded, no truncation semantics)
    "e": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
}


@dataclass
class Token:
    kind: str  # "WORD" | "OP"
    text: str | None = None  # OP: exact operator text (e.g. ">>", "2>&1", "\n")
    segments: list[Segment] | None = None  # WORD: ordered segments


def _unterminated(what: str) -> UnsupportedConstruct:
    # Not part of the frozen §2.3 catalog: a defensive, never-crash refusal for
    # genuinely malformed input (unbalanced quote/paren/brace). No acceptance test
    # requires this id; flagged for architect review in the WP-A report.
    return UnsupportedConstruct("malformed-syntax", f"Unterminated {what}: the command has an unbalanced quote or bracket.")


def _ansi_c_unescape(text: str) -> str:
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c != "\\" or i + 1 >= n:
            out.append(c)
            i += 1
            continue
        nxt = text[i + 1]
        if nxt in _ANSI_C_MAP:
            out.append(_ANSI_C_MAP[nxt])
            i += 2
            continue
        if nxt == "0":
            j = i + 2
            digits = ""
            while j < n and len(digits) < 3 and text[j] in "01234567":
                digits += text[j]
                j += 1
            out.append(chr(int(digits, 8)) if digits else "\0")
            i = j
            continue
        if nxt == "x":
            j = i + 2
            digits = ""
            while j < n and len(digits) < 2 and text[j] in "0123456789abcdefABCDEF":
                digits += text[j]
                j += 1
            out.append(chr(int(digits, 16)) if digits else "x")
            i = j
            continue
        out.append(nxt)
        i += 2
    return "".join(out)


def _find_closing_paren(src: str, pos: int) -> int:
    """`pos` is the index right after the opening '('. Returns the index of the matching ')'."""
    n = len(src)
    depth = 1
    i = pos
    while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n:
            i += 2
            continue
        if c == "'":
            j = src.find("'", i + 1)
            if j == -1:
                raise _unterminated("single quote")
            i = j + 1
            continue
        if c == '"':
            i = _skip_double_quote(src, i + 1)
            continue
        if c == "(":
            depth += 1
            i += 1
            continue
        if c == ")":
            depth -= 1
            if depth == 0:
                return i
            i += 1
            continue
        i += 1
    raise _unterminated("'('")


def _skip_double_quote(src: str, pos: int) -> int:
    """`pos` is the index right after the opening '"'. Returns the index right after the closing '"'."""
    n = len(src)
    i = pos
    while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n:
            i += 2
            continue
        if c == '"':
            return i + 1
        i += 1
    raise _unterminated('double quote')


def _find_closing_brace(src: str, pos: int) -> int:
    """`pos` is the index right after the opening '{'. Returns the index of the matching '}'."""
    n = len(src)
    depth = 1
    i = pos
    while i < n:
        c = src[i]
        if c == "\\" and i + 1 < n:
            i += 2
            continue
        if c == "'":
            j = src.find("'", i + 1)
            if j == -1:
                raise _unterminated("single quote")
            i = j + 1
            continue
        if c == '"':
            i = _skip_double_quote(src, i + 1)
            continue
        if src[i : i + 2] == "${":
            depth += 1
            i += 2
            continue
        if src[i : i + 2] == "$(":
            i = _find_closing_paren(src, i + 2) + 1
            continue
        if c == "}":
            depth -= 1
            if depth == 0:
                return i
            i += 1
            continue
        i += 1
    raise _unterminated("'{'")


def _scan_param_arg_word(text: str) -> Word:
    """Scan a `${VAR:-arg}`-style default/assign/alt/err argument into a `Word`.

    Unlike `_scan_word`, this consumes the ENTIRE `text` (already delimited by the matching
    closing brace found by `_find_closing_brace`): whitespace inside is literal content within
    Raw segments, not a word-boundary terminator (bash: `${V:-a b}` -> the default word is the
    full "a b", not just "a"). Quoting and $-forms inside are still parsed as segments.
    """
    n = len(text)
    segments: list[Segment] = []
    buf: list[str] = []
    i = 0

    def flush() -> None:
        if buf:
            segments.append(Raw(text="".join(buf)))
            buf.clear()

    while i < n:
        c = text[i]
        if c == "\\":
            if i + 1 < n:
                flush()
                segments.append(Lit(text=text[i + 1]))
                i += 2
            else:
                buf.append(c)
                i += 1
            continue
        if c == "'":
            j = text.find("'", i + 1)
            if j == -1:
                raise _unterminated("single quote")
            flush()
            segments.append(Lit(text=text[i + 1 : j]))
            i = j + 1
            continue
        if c == '"':
            flush()
            dq_segments, newpos = _scan_dq_segments(text, i + 1)
            segments.append(DQ(segments=dq_segments))
            i = newpos
            continue
        if c == "$" and text[i + 1 : i + 2] == "'":
            j = i + 2
            raw_chars: list[str] = []
            while j < n and text[j] != "'":
                if text[j] == "\\" and j + 1 < n:
                    raw_chars.append(text[j])
                    raw_chars.append(text[j + 1])
                    j += 2
                else:
                    raw_chars.append(text[j])
                    j += 1
            if j >= n:
                raise _unterminated("$'...' quote")
            flush()
            segments.append(Lit(text=_ansi_c_unescape("".join(raw_chars))))
            i = j + 1
            continue
        if c == "$":
            seg, newpos = _scan_dollar_form(text, i)
            if isinstance(seg, Lit) and seg.text == "$" and newpos == i + 1:
                buf.append("$")
                i = newpos
                continue
            flush()
            segments.append(seg)
            i = newpos
            continue
        if c == "`":
            j = i + 1
            while j < n and text[j] != "`":
                if text[j] == "\\" and j + 1 < n:
                    j += 2
                else:
                    j += 1
            if j >= n:
                raise _unterminated("backtick")
            flush()
            segments.append(CmdSub(src=text[i + 1 : j]))
            i = j + 1
            continue
        buf.append(c)
        i += 1
    flush()
    return Word(segments=segments)


def _parse_param_brace_content(content: str) -> Param:
    if content.startswith("#"):
        return Param(name=content[1:], op="#len", arg=None)
    m = _IDENT_RE.match(content)
    name = m.group(0) if m else ""
    rest = content[len(name) :]
    for candidate in (":-", ":=", ":+", ":?"):
        if rest.startswith(candidate):
            arg_text = rest[len(candidate) :]
            # Scan the FULL remainder into one Word: the default/alt/assign/err argument runs
            # up to the already-matched closing brace, so whitespace inside it is literal text
            # within Raw segments (bash: `${V:-a b}` -> default word is "a b", not just "a").
            # Do not truncate at the first _scan_word word-boundary space.
            arg_word = _scan_param_arg_word(arg_text) if arg_text else Word(segments=[])
            return Param(name=name, op=candidate, arg=arg_word)
    if rest:
        raise UnsupportedConstruct(
            "parameter-expansion",
            f"Unsupported parameter expansion form '${{{content}}}': only ${{VAR}}, ${{VAR:-w}}, "
            "${VAR:=w}, ${VAR:+w}, ${VAR:?w}, and ${#VAR} are supported.",
        )
    return Param(name=name, op=None, arg=None)


def _scan_dollar_form(src: str, pos: int) -> tuple[Segment, int]:
    """`pos` is the index of '$'. Returns (segment, new_pos)."""
    n = len(src)
    nxt = src[pos + 1] if pos + 1 < n else ""
    if nxt == "{":
        close = _find_closing_brace(src, pos + 2)
        return _parse_param_brace_content(src[pos + 2 : close]), close + 1
    if nxt == "(":
        if src[pos + 2 : pos + 3] == "(":
            raise UnsupportedConstruct(
                "arithmetic-expansion", "Arithmetic expansion '$((...))' is not supported."
            )
        close = _find_closing_paren(src, pos + 2)
        return CmdSub(src=src[pos + 2 : close]), close + 1
    if nxt and (_IDENT_START_RE.match(nxt)):
        m = _IDENT_RE.match(src, pos + 1)
        assert m is not None
        return Param(name=m.group(0), op=None, arg=None), m.end()
    # Bare '$' with nothing recognizable following: literal '$'.
    return Lit(text="$"), pos + 1


def _scan_dq_segments(src: str, pos: int) -> tuple[list[Segment], int]:
    """`pos` is the index right after the opening '"'. Returns (segments, new_pos-after-closing-quote)."""
    n = len(src)
    segments: list[Segment] = []
    buf: list[str] = []
    i = pos

    def flush() -> None:
        if buf:
            segments.append(Lit(text="".join(buf)))
            buf.clear()

    while i < n:
        c = src[i]
        if c == '"':
            flush()
            return segments, i + 1
        if c == "\\" and i + 1 < n:
            nxt = src[i + 1]
            if nxt in ('"', "\\", "$", "`"):
                buf.append(nxt)
                i += 2
            elif nxt == "\n":
                i += 2
            else:
                buf.append(c)
                buf.append(nxt)
                i += 2
            continue
        if c == "$":
            seg, newpos = _scan_dollar_form(src, i)
            if isinstance(seg, Lit) and seg.text == "$" and newpos == i + 1:
                buf.append("$")
                i = newpos
                continue
            flush()
            segments.append(seg)
            i = newpos
            continue
        if c == "`":
            j = i + 1
            while j < n and src[j] != "`":
                if src[j] == "\\" and j + 1 < n:
                    j += 2
                else:
                    j += 1
            if j >= n:
                raise _unterminated("backtick")
            flush()
            segments.append(CmdSub(src=src[i + 1 : j]))
            i = j + 1
            continue
        buf.append(c)
        i += 1
    raise _unterminated("double quote")


_WORD_BOUNDARY_CHARS = set("|&;()<> \t\n")
_EXTGLOB_PREFIX_CHARS = set("@!?*+")
_DRIVE_PREFIX_RE = re.compile(r"^[A-Za-z]:")


def _scan_word(src: str, pos: int) -> tuple[Word, int]:
    n = len(src)
    segments: list[Segment] = []
    buf: list[str] = []
    i = pos
    at_word_start = True

    def flush() -> None:
        if buf:
            segments.append(Raw(text="".join(buf)))
            buf.clear()

    while i < n:
        c = src[i]
        if at_word_start and c == "~":
            j = i + 1
            while j < n and src[j] not in _WORD_BOUNDARY_CHARS and src[j] not in "\"'\\$`/":
                j += 1
            segments.append(Tilde(user=src[i + 1 : j]))
            i = j
            at_word_start = False
            continue
        at_word_start = False
        if c in _WORD_BOUNDARY_CHARS:
            break
        if c in _EXTGLOB_PREFIX_CHARS and src[i + 1 : i + 2] == "(":
            raise UnsupportedConstruct(
                "extended-glob", "Extended glob patterns ('@(...)','!(...)', etc.) are not supported."
            )
        if c == "{":
            j = i + 1
            depth = 1
            has_comma = False
            while j < n and depth > 0:
                if src[j] == "{":
                    depth += 1
                elif src[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                elif src[j] == "," and depth == 1:
                    has_comma = True
                j += 1
            if depth != 0:
                buf.append(c)
                i += 1
                continue
            if has_comma:
                raise UnsupportedConstruct(
                    "brace-expansion", "Brace expansion ('{a,b,c}') is not supported; list the values explicitly."
                )
            buf.append(src[i : j + 1])
            i = j + 1
            continue
        if c == "\\":
            # Windows absolute paths: a backslash inside a word already recognized as a
            # drive-letter path ('C:\...') or a UNC path ('\\server\...') is preserved
            # literally rather than treated as a POSIX escape of the next character.
            # Mirrors the TS router's identical heuristic (shell-contract-router.ts).
            buf_text = "".join(buf)
            if _DRIVE_PREFIX_RE.match(buf_text) or buf_text.startswith("\\\\"):
                buf.append(c)
                i += 1
                continue
            if not buf and not segments and src[i + 1 : i + 2] == "\\":
                buf.append("\\\\")
                i += 2
                continue
            if i + 1 < n:
                flush()
                segments.append(Lit(text=src[i + 1]))
                i += 2
            else:
                buf.append(c)
                i += 1
            continue
        if c == "'":
            j = src.find("'", i + 1)
            if j == -1:
                raise _unterminated("single quote")
            flush()
            segments.append(Lit(text=src[i + 1 : j]))
            i = j + 1
            continue
        if c == '"':
            flush()
            dq_segments, newpos = _scan_dq_segments(src, i + 1)
            segments.append(DQ(segments=dq_segments))
            i = newpos
            continue
        if c == "$" and src[i + 1 : i + 2] == "'":
            j = i + 2
            raw_chars: list[str] = []
            while j < n and src[j] != "'":
                if src[j] == "\\" and j + 1 < n:
                    raw_chars.append(src[j])
                    raw_chars.append(src[j + 1])
                    j += 2
                else:
                    raw_chars.append(src[j])
                    j += 1
            if j >= n:
                raise _unterminated("$'...' quote")
            flush()
            segments.append(Lit(text=_ansi_c_unescape("".join(raw_chars))))
            i = j + 1
            continue
        if c == "$":
            seg, newpos = _scan_dollar_form(src, i)
            if isinstance(seg, Lit) and seg.text == "$" and newpos == i + 1:
                buf.append("$")
                i = newpos
                continue
            flush()
            segments.append(seg)
            i = newpos
            continue
        if c == "`":
            j = i + 1
            while j < n and src[j] != "`":
                if src[j] == "\\" and j + 1 < n:
                    j += 2
                else:
                    j += 1
            if j >= n:
                raise _unterminated("backtick")
            flush()
            segments.append(CmdSub(src=src[i + 1 : j]))
            i = j + 1
            continue
        buf.append(c)
        i += 1
    flush()
    return Word(segments=segments), i


def _scan_operator(src: str, pos: int) -> tuple[str, int]:
    """`src[pos]` starts an operator character. Returns (operator text, new_pos)."""
    if src[pos : pos + 3] == "<<-":
        raise UnsupportedConstruct("heredoc", "Heredocs ('<<-') are not supported; use a temp file or a literal argument.")
    if src[pos : pos + 3] == "<<<":
        raise UnsupportedConstruct("here-string", "Here-strings ('<<<') are not supported; pipe the value in instead.")
    if src[pos : pos + 2] == "<<":
        raise UnsupportedConstruct("heredoc", "Heredocs ('<<') are not supported; use a temp file or a literal argument.")
    if src[pos : pos + 2] == "&>":
        return "&>", pos + 2
    if src[pos : pos + 2] == "&&":
        return "&&", pos + 2
    if src[pos : pos + 2] == "||":
        return "||", pos + 2
    if src[pos : pos + 2] == ">>":
        return ">>", pos + 2
    if src[pos : pos + 2] == ">&":
        j = pos + 2
        while j < len(src) and src[j].isdigit():
            j += 1
        return src[pos:j], j
    if src[pos] == "<" and src[pos + 1 : pos + 2] == "(":
        raise UnsupportedConstruct("process-substitution", "Process substitution ('<(...)') is not supported.")
    if src[pos] == ">" and src[pos + 1 : pos + 2] == "(":
        raise UnsupportedConstruct("process-substitution", "Process substitution ('>(...)') is not supported.")
    if src[pos] in "|&;(){}<>":
        return src[pos], pos + 1
    raise AssertionError(f"unreachable operator dispatch at {pos!r}")


def tokenize(src: str) -> list[Token]:
    n = len(src)
    tokens: list[Token] = []
    pos = 0
    while pos < n:
        c = src[pos]
        if c in " \t":
            pos += 1
            continue
        if c == "\n":
            tokens.append(Token(kind="OP", text="\n"))
            pos += 1
            continue
        if c == "\\" and src[pos + 1 : pos + 2] == "\n":
            pos += 2
            continue
        # An unquoted # starts a comment only at a token boundary. A # inside a
        # word (for example a#b) and a quoted # are ordinary data.
        if c == "#" and (pos == 0 or src[pos - 1] in " \t\n;|&()"):
            newline = src.find("\n", pos)
            pos = n if newline == -1 else newline
            continue
        if src[pos : pos + 2] == "((":
            raise UnsupportedConstruct("arithmetic-expansion", "Arithmetic command '((...))' is not supported.")
        if c.isdigit():
            j = pos
            while j < n and src[j].isdigit():
                j += 1
            if j < n and src[j] in "<>":
                op_text, newpos = _scan_operator(src, j)
                tokens.append(Token(kind="OP", text=src[pos:j] + op_text))
                pos = newpos
                continue
        if c == "{" and not (pos + 1 >= n or src[pos + 1] in " \t\n"):
            word, newpos = _scan_word(src, pos)
            tokens.append(Token(kind="WORD", segments=word.segments))
            pos = newpos
            continue
        if c in "|&;(){}<>":
            op_text, newpos = _scan_operator(src, pos)
            tokens.append(Token(kind="OP", text=op_text))
            pos = newpos
            continue
        word, newpos = _scan_word(src, pos)
        tokens.append(Token(kind="WORD", segments=word.segments))
        pos = newpos
    return tokens
