"""Pure byte/text codec for managed edits. No target paths or executable input.

Matching and newline policy belong to the TypeScript edit planner. This helper
validates its source-coordinate splices, preserves untouched source bytes, and
encodes only replacements with the same strict codec. It never writes a file.
"""
import base64
import codecs
import json
import sys

MAX_PROTOCOL = 64 * 1024 * 1024
MAX_SOURCE = 16 * 1024 * 1024
BOMS = (
    (codecs.BOM_UTF32_LE, "utf-32-le"),
    (codecs.BOM_UTF32_BE, "utf-32-be"),
    (codecs.BOM_UTF8, "utf-8"),
    (codecs.BOM_UTF16_LE, "utf-16-le"),
    (codecs.BOM_UTF16_BE, "utf-16-be"),
)


class EncodingEvidenceRequired(ValueError):
    pass


def transform(request):
    original = base64.b64decode(request["source"], validate=True)
    if len(original) > MAX_SOURCE:
        raise ValueError("source bound")
    bom, detected = next(((b, c) for b, c in BOMS if original.startswith(b)), (b"", None))
    requested = request.get("encoding")
    encoding = codecs.lookup(requested).name if requested else detected
    if not encoding:
        raise EncodingEvidenceRequired("explicit encoding required")
    if detected:
        if encoding not in (detected, detected.rsplit("-", 1)[0], "utf-8-sig" if detected == "utf-8" else detected):
            raise ValueError("encoding conflicts with BOM")
        encoding = detected
    elif encoding in ("utf-16", "utf-32", "utf-8-sig"):
        raise ValueError("codec requires BOM or explicit byte order")
    source = original[len(bom):]
    text = source.decode(encoding, errors="strict")
    if not isinstance(text, str) or "\0" in text or text.encode(encoding, errors="strict") != source:
        raise ValueError("source does not round-trip as text")
    if request["operation"] == "decode":
        return {"text": text, "encoding": encoding}
    if request["operation"] != "splice":
        raise ValueError("unknown operation")

    # JS planner offsets are UTF-16 code units, not Python code-point indices.
    spans = request["splices"]
    wanted = {0}
    previous = 0
    for span in spans:
        start, end = span["start"], span["end"]
        if type(start) is not int or type(end) is not int or start < previous or end < start:
            raise ValueError("invalid source spans")
        wanted.update((start, end))
        previous = end
    boundaries = {0: 0}
    units = 0
    for index, char in enumerate(text):
        units += 2 if ord(char) > 0xFFFF else 1
        if units in wanted:
            boundaries[units] = index + 1
    if wanted != boundaries.keys():
        raise ValueError("span splits a character or exceeds source")

    byte_cursor = 0
    char_cursor = 0
    output = [bom]
    expected = []
    for span in spans:
        start, end = boundaries[span["start"]], boundaries[span["end"]]
        untouched = text[char_cursor:start]
        removed = text[start:end]
        prefix = untouched.encode(encoding, errors="strict")
        old = removed.encode(encoding, errors="strict")
        # Stateful/noncanonical representations cannot silently rewrite neighbors.
        if source[byte_cursor:byte_cursor + len(prefix) + len(old)] != prefix + old:
            raise ValueError("codec cannot preserve source span boundaries")
        replacement = span["replacement"]
        if not isinstance(replacement, str) or "\0" in replacement:
            raise ValueError("invalid replacement")
        encoded = replacement.encode(encoding, errors="strict")
        output.extend((source[byte_cursor:byte_cursor + len(prefix)], encoded))
        expected.extend((untouched, replacement))
        byte_cursor += len(prefix) + len(old)
        char_cursor = end
    remainder = text[char_cursor:]
    if remainder.encode(encoding, errors="strict") != source[byte_cursor:]:
        raise ValueError("codec cannot preserve source suffix")
    output.append(source[byte_cursor:])
    expected.append(remainder)
    result = b"".join(output)
    if len(result) > MAX_SOURCE or result[len(bom):].decode(encoding, errors="strict") != "".join(expected):
        raise ValueError("encoded edit verification failed")
    return {"bytes": base64.b64encode(result).decode("ascii"), "encoding": encoding}


try:
    payload = sys.stdin.buffer.read(MAX_PROTOCOL + 1)
    if len(payload) > MAX_PROTOCOL:
        raise ValueError("protocol bound")
    result = transform(json.loads(payload))
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
except Exception as error:
    # Never echo source bytes, replacement text, or a traceback into diagnostics.
    reason = "encoding_required" if isinstance(error, EncodingEvidenceRequired) else "preservation_unverified"
    sys.stdout.buffer.write(json.dumps({"error": reason}).encode("ascii"))
    sys.exit(1)
