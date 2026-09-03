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
from escapes import ANSI_C_ESCAPES, decode_backslash_escapes
from nodes import CmdSub, DQ, Lit, Param, Raw, Segment, Tilde, Word

_IDENT_START_RE = re.compile(r"[A-Za-z_]")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
@dataclass
class Token:
    kind: str  # "WORD" | "OP" | "ARITH"
    text: str | None = None  # OP: exact operator text (e.g. ">>", "2>&1", "\n")
    segments: list[Segment] | None = None  # WORD: ordered segments


def _unterminated(what: str) -> UnsupportedConstruct:
    # Not part of the frozen §2.3 catalog: a defensive, never-crash refusal for
    # genuinely malformed input (unbalanced quote/paren/brace). No acceptance test
    # requires this id; flagged for architect review in the WP-A report.
    return UnsupportedConstruct("malformed-syntax", f"Unterminated {what}: the command has an unbalanced quote or bracket.")


def _find_closing_paren(src: str, pos: int) -> int:
    """`pos` is the index right after the opening '('. Returns the index of the matching ')'."""
    return _find_closing_group(src, pos, "(", ")")


def _skip_double_quote(src: str, pos: int) -> int:
    """`pos` is the index right after the opening '"'. Returns the index right after the closing '"'."""
    return _find_unescaped_character(src, pos, '"', "double quote") + 1


def _find_unescaped_character(src: str, pos: int, closing: str, description: str) -> int:
    i = src.find(closing, pos)
    while i != -1:
        backslashes = 0
        cursor = i - 1
        while cursor >= pos and src[cursor] == "\\":
            backslashes += 1
            cursor -= 1
        if backslashes % 2 == 0:
            return i
        i = src.find(closing, i + 1)
    raise _unterminated(description)


def _find_closing_group(src: str, pos: int, opening: str, closing: str) -> int:
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
        if opening == "{" and src[i : i + 2] == "${":
            depth += 1
            i += 2
            continue
        if opening == "{" and src[i : i + 2] == "$(":
            i = _find_closing_group(src, i + 2, "(", ")") + 1
            continue
        if c == opening:
            depth += 1
            i += 1
            continue
        if c == closing:
            depth -= 1
            if depth == 0:
                return i
            i += 1
            continue
        i += 1
    raise _unterminated(repr(opening))


def _find_closing_brace(src: str, pos: int) -> int:
    """`pos` is the index right after the opening '{'. Returns the index of the matching '}'."""
    return _find_closing_group(src, pos, "{", "}")


def _scan_ansi_c_quote(src: str, pos: int) -> tuple[Lit, int]:
    j = pos + 2
    raw_chars: list[str] = []
    while j < len(src) and src[j] != "'":
        if src[j] == "\\" and j + 1 < len(src):
            raw_chars.extend((src[j], src[j + 1]))
            j += 2
        else:
            raw_chars.append(src[j])
            j += 1
    if j >= len(src):
        raise _unterminated("$'...' quote")
    decoded, _ = decode_backslash_escapes("".join(raw_chars), ANSI_C_ESCAPES)
    return Lit(text=decoded), j + 1


def _flush_buffer(
    segments: list[Segment], buf: list[str], literal_buffer: bool
) -> None:
    if not buf:
        return
    text = "".join(buf)
    segments.append(Lit(text=text) if literal_buffer else Raw(text=text))
    buf.clear()


def _scan_or_append(
    src: str,
    pos: int,
    segments: list[Segment],
    buf: list[str],
    *,
    literal_buffer: bool,
    unquoted: bool,
) -> int:
    c = src[pos]
    if unquoted and c == "'":
        close = src.find("'", pos + 1)
        if close == -1:
            raise _unterminated("single quote")
        _flush_buffer(segments, buf, literal_buffer)
        segments.append(Lit(text=src[pos + 1 : close]))
        return close + 1
    if unquoted and c == '"':
        _flush_buffer(segments, buf, literal_buffer)
        dq_segments, new_pos = _scan_dq_segments(src, pos + 1)
        segments.append(DQ(segments=dq_segments))
        return new_pos
    if unquoted and c == "$" and src[pos + 1 : pos + 2] == "'":
        segment, new_pos = _scan_ansi_c_quote(src, pos)
        _flush_buffer(segments, buf, literal_buffer)
        segments.append(segment)
        return new_pos
    if c == "$":
        segment, new_pos = _scan_dollar_form(src, pos)
        if isinstance(segment, Lit) and segment.text == "$" and new_pos == pos + 1:
            buf.append("$")
        else:
            _flush_buffer(segments, buf, literal_buffer)
            segments.append(segment)
        return new_pos
    if c != "`":
        buf.append(c)
        return pos + 1

    j = pos + 1
    while j < len(src) and src[j] != "`":
        j += 2 if src[j] == "\\" and j + 1 < len(src) else 1
    if j >= len(src):
        raise _unterminated("backtick")
    _flush_buffer(segments, buf, literal_buffer)
    segments.append(CmdSub(src=src[pos + 1 : j]))
    return j + 1


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

    while i < n:
        c = text[i]
        if c == "\\":
            if i + 1 < n:
                _flush_buffer(segments, buf, False)
                segments.append(Lit(text=text[i + 1]))
                i += 2
            else:
                buf.append(c)
                i += 1
            continue
        i = _scan_or_append(
            text, i, segments, buf, literal_buffer=False, unquoted=True
        )
    _flush_buffer(segments, buf, False)
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
    if nxt == "?":
        return Param(name="?", op=None, arg=None), pos + 2
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

    while i < n:
        c = src[i]
        if c == '"':
            _flush_buffer(segments, buf, True)
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
        i = _scan_or_append(
            src, i, segments, buf, literal_buffer=True, unquoted=False
        )
    raise _unterminated("double quote")


_WORD_BOUNDARY_CHARS = set("|&;()<> \t\n")
_EXTGLOB_PREFIX_CHARS = set("@!?*+")


def _is_drive_path_prefix(buf: list[str]) -> bool:
    return len(buf) >= 2 and len(buf[0]) == 1 and buf[0].isalpha() and buf[1] == ":"


def _scan_word(src: str, pos: int) -> tuple[Word, int]:
    n = len(src)
    segments: list[Segment] = []
    buf: list[str] = []
    i = pos
    at_word_start = True
    preserve_backslashes = False

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
            if preserve_backslashes or _is_drive_path_prefix(buf):
                preserve_backslashes = True
                buf.append(c)
                i += 1
                continue
            if not buf and not segments and src[i + 1 : i + 2] == "\\":
                buf.append("\\\\")
                preserve_backslashes = True
                i += 2
                continue
            if i + 1 < n:
                _flush_buffer(segments, buf, False)
                segments.append(Lit(text=src[i + 1]))
                i += 2
            else:
                buf.append(c)
                i += 1
            continue
        i = _scan_or_append(
            src, i, segments, buf, literal_buffer=False, unquoted=True
        )
    _flush_buffer(segments, buf, False)
    return Word(segments=segments), i


def _scan_operator(src: str, pos: int) -> tuple[str, int]:
    """`src[pos]` starts an operator character. Returns (operator text, new_pos)."""
    if src[pos : pos + 3] == "<<-":
        return "<<-", pos + 3
    if src[pos : pos + 3] == "<<<":
        return "<<<", pos + 3
    if src[pos : pos + 2] == "<<":
        return "<<", pos + 2
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


def _scan_arithmetic_group(src: str, pos: int) -> tuple[str, int]:
    """Scan ``((...))`` as one token while allowing balanced inner parentheses."""
    depth = 0
    cursor = pos + 2
    while cursor < len(src):
        if src[cursor : cursor + 2] == "))" and depth == 0:
            return src[pos + 2 : cursor], cursor + 2
        char = src[cursor]
        if char == "(":
            depth += 1
        elif char == ")":
            if depth == 0:
                raise UnsupportedConstruct(
                    "malformed-syntax", "Arithmetic loop header contains an unmatched ')'."
                )
            depth -= 1
        cursor += 1
    raise _unterminated("arithmetic loop header")


def _read_heredoc_body(src: str, pos: int, delimiter: str, strip_tabs: bool) -> tuple[str, int]:
    """Consume heredoc lines starting at `pos` (just after a newline) up to the delimiter line."""
    lines: list[str] = []
    while pos < len(src):
        newline = src.find("\n", pos)
        line = src[pos:] if newline == -1 else src[pos:newline]
        pos = len(src) if newline == -1 else newline + 1
        candidate = line.lstrip("\t") if strip_tabs else line
        if candidate == delimiter:
            return "".join(l + "\n" for l in lines), pos
        lines.append(candidate)
    raise UnsupportedConstruct("malformed-syntax", f"Heredoc delimiter {delimiter!r} was never closed.")


def tokenize(src: str) -> list[Token]:
    n = len(src)
    tokens: list[Token] = []
    pos = 0
    # Heredocs (<<EOF ... EOF, <<-EOF, <<< word): the body becomes the redirect's target word as
    # one literal, so a command can receive multi-line input without a temp file. The measured
    # sessions were refused on `<<` alone; the engine now reads the body like a shell does.
    pending_heredocs: list[tuple[int, str, bool]] = []
    while pos < n:
        c = src[pos]
        if c in " \t":
            pos += 1
            continue
        if c == "\n":
            tokens.append(Token(kind="OP", text="\n"))
            pos += 1
            for token_index, delimiter, strip_tabs in pending_heredocs:
                body, pos = _read_heredoc_body(src, pos, delimiter, strip_tabs)
                tokens[token_index] = Token(kind="WORD", segments=[Lit(text=body)])
            pending_heredocs = []
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
            arithmetic, newpos = _scan_arithmetic_group(src, pos)
            tokens.append(Token(kind="ARITH", text=arithmetic))
            pos = newpos
            continue
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
            if op_text in ("<<", "<<-"):
                while pos < n and src[pos] in " \t":
                    pos += 1
                delimiter_word, pos = _scan_word(src, pos)
                delimiter = "".join(getattr(segment, "text", "") for segment in delimiter_word.segments)
                tokens.append(Token(kind="WORD", segments=[Lit(text="")]))
                pending_heredocs.append((len(tokens) - 1, delimiter, op_text == "<<-"))
            continue
        word, newpos = _scan_word(src, pos)
        tokens.append(Token(kind="WORD", segments=word.segments))
        pos = newpos
    if pending_heredocs:
        for token_index, delimiter, strip_tabs in pending_heredocs:
            body, pos = _read_heredoc_body(src, pos, delimiter, strip_tabs)
            tokens[token_index] = Token(kind="WORD", segments=[Lit(text=body)])
    return tokens
