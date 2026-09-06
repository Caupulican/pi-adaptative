"""Pure byte/text codec for managed reads and edits. No target paths or executable input.

Matching and newline policy belong to the TypeScript edit planner. This helper
validates its source-coordinate splices, preserves untouched source bytes, and
encodes only replacements with the same strict codec. Read-only incremental
decoding carries codec state between bounded chunks, without edit round-trip
requirements. BOM/encoding selection is shared. This helper never writes a file.
"""
import base64
import codecs
import json
import os
import re
import shutil
import subprocess
import sys
import threading

MAX_PROTOCOL = 64 * 1024 * 1024
MAX_SOURCE = 16 * 1024 * 1024
MAX_ICONV_OUTPUT = 4 * MAX_SOURCE
ICONV_TIMEOUT = 5
BOMS = (
    (codecs.BOM_UTF32_LE, "utf-32-le"),
    (codecs.BOM_UTF32_BE, "utf-32-be"),
    (codecs.BOM_UTF8, "utf-8"),
    (codecs.BOM_UTF16_LE, "utf-16-le"),
    (codecs.BOM_UTF16_BE, "utf-16-be"),
)


class EncodingEvidenceRequired(ValueError):
    pass


class CodecUnavailable(LookupError):
    pass


def run_iconv(executable, source_encoding, target_encoding, data):
    """Bounded binary transport. No shell, target paths, lossy flags, or stderr payloads."""
    if len(data) > MAX_ICONV_OUTPUT:
        raise ValueError("iconv input bound")
    child = subprocess.Popen(
        [executable, "-f", source_encoding, "-t", target_encoding],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    failed = threading.Event()
    timed_out = threading.Event()

    def send():
        try:
            with child.stdin:
                child.stdin.write(data)
        except Exception:
            failed.set()

    def expire():
        timed_out.set()
        child.kill()

    writer = threading.Thread(target=send, daemon=True)
    timer = threading.Timer(ICONV_TIMEOUT, expire)
    timer.start()
    writer.start()
    try:
        output = child.stdout.read(MAX_ICONV_OUTPUT + 1)
        if len(output) > MAX_ICONV_OUTPUT:
            raise ValueError("iconv output bound")
        code = child.wait()
        writer.join()
        if code != 0 or failed.is_set() or timed_out.is_set():
            raise ValueError("iconv conversion unverified")
        return output
    finally:
        timer.cancel()
        child.kill()
        child.wait()
        writer.join()
        timer.join()
        child.stdout.close()


class IconvDecoder(codecs.IncrementalDecoder):
    """Opaque iconv state cannot be serialized; retain bounded bytes until final decode."""
    def __init__(self, codec, errors):
        super().__init__(errors)
        self.codec = codec
        self.pending = b""

    def decode(self, source, final=False):
        if len(self.pending) + len(source) > MAX_SOURCE:
            raise ValueError("iconv read state bound")
        self.pending += source
        if not final:
            return ""
        text = self.codec.decode(self.pending, self.errors)[0]
        self.pending = b""
        return text

    def getstate(self):
        return self.pending, 0

    def setstate(self, state):
        if state[1] != 0 or len(state[0]) > MAX_SOURCE:
            raise ValueError("invalid iconv decoder state")
        self.pending = state[0]


class IconvCodec:
    def __init__(self, name):
        # Labels are data, not command options or iconv //IGNORE / //TRANSLIT directives.
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}", name):
            raise LookupError("unsupported codec label")
        executable = shutil.which("iconv")
        if not executable:
            raise CodecUnavailable("iconv unavailable")
        self.name = name
        self.executable = os.path.abspath(executable)

    def encode(self, text, errors="strict"):
        if errors != "strict":
            raise ValueError("strict conversion required")
        encoded = run_iconv(self.executable, "UTF-8", self.name, text.encode("utf-8", "strict"))
        # Some platform implementations substitute even without a lossy flag.
        if run_iconv(self.executable, self.name, "UTF-8", encoded).decode("utf-8", "strict") != text:
            raise ValueError("iconv changed replacement text")
        return encoded, len(text)

    def decode(self, source, errors="strict"):
        if errors != "strict":
            raise ValueError("strict conversion required")
        text = run_iconv(self.executable, self.name, "UTF-8", source).decode("utf-8", "strict")
        if run_iconv(self.executable, "UTF-8", self.name, text.encode("utf-8", "strict")) != source:
            raise ValueError("iconv source roundtrip unverified")
        return text, len(source)

    def incrementaldecoder(self, errors="strict"):
        return IconvDecoder(self, errors)


def lookup_codec(name):
    try:
        return codecs.lookup(name)
    except LookupError:
        return IconvCodec(name)


def select_encoding(original, requested):
    bom, detected = next(((b, c) for b, c in BOMS if original.startswith(b)), (b"", None))
    encoding = lookup_codec(requested).name if requested else detected
    if not encoding:
        raise EncodingEvidenceRequired("explicit encoding required")
    if detected:
        if encoding not in (detected, detected.rsplit("-", 1)[0], "utf-8-sig" if detected == "utf-8" else detected):
            raise ValueError("encoding conflicts with BOM")
        encoding = detected
    elif encoding in ("utf-16", "utf-32", "utf-8-sig"):
        raise ValueError("codec requires BOM or explicit byte order")
    return bom, encoding, original[len(bom):]


def read_chunk(request, original):
    state = request.get("state")
    if state is None:
        _, encoding, source = select_encoding(original, request.get("encoding"))
    else:
        encoding = lookup_codec(request["encoding"]).name
        source = original
    decoder = lookup_codec(encoding).incrementaldecoder(errors="strict")
    if state is not None:
        if not isinstance(state, list) or len(state) != 2 or type(state[1]) is not int:
            raise ValueError("invalid decoder state")
        pending = base64.b64decode(state[0], validate=True)
        if len(pending) > MAX_SOURCE:
            raise ValueError("decoder state bound")
        decoder.setstate((pending, state[1]))
    if type(request["final"]) is not bool:
        raise ValueError("invalid final marker")
    text = decoder.decode(source, final=request["final"])
    if not isinstance(text, str) or "\0" in text:
        raise ValueError("not text")
    pending, flag = decoder.getstate()
    if len(pending) > MAX_SOURCE:
        raise ValueError("decoder state bound")
    return {"text": text, "encoding": encoding,
            "state": [base64.b64encode(pending).decode("ascii"), flag]}


def transform(request):
    original = base64.b64decode(request["source"], validate=True)
    if len(original) > MAX_SOURCE:
        raise ValueError("source bound")
    if request["operation"] == "read_chunk":
        return read_chunk(request, original)
    bom, encoding, source = select_encoding(original, request.get("encoding"))
    codec = lookup_codec(encoding)
    text = codec.decode(source, "strict")[0]
    if not isinstance(text, str) or "\0" in text or codec.encode(text, "strict")[0] != source:
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
        prefix = codec.encode(untouched, "strict")[0]
        old = codec.encode(removed, "strict")[0]
        # Stateful/noncanonical representations cannot silently rewrite neighbors.
        if source[byte_cursor:byte_cursor + len(prefix) + len(old)] != prefix + old:
            raise ValueError("codec cannot preserve source span boundaries")
        replacement = span["replacement"]
        if not isinstance(replacement, str) or "\0" in replacement:
            raise ValueError("invalid replacement")
        encoded = codec.encode(replacement, "strict")[0]
        output.extend((source[byte_cursor:byte_cursor + len(prefix)], encoded))
        expected.extend((untouched, replacement))
        byte_cursor += len(prefix) + len(old)
        char_cursor = end
    remainder = text[char_cursor:]
    if codec.encode(remainder, "strict")[0] != source[byte_cursor:]:
        raise ValueError("codec cannot preserve source suffix")
    output.append(source[byte_cursor:])
    expected.append(remainder)
    result = b"".join(output)
    if len(result) > MAX_SOURCE or codec.decode(result[len(bom):], "strict")[0] != "".join(expected):
        raise ValueError("encoded edit verification failed")
    return {"bytes": base64.b64encode(result).decode("ascii"), "encoding": encoding}


if __name__ == "__main__":
    try:
        payload = sys.stdin.buffer.read(MAX_PROTOCOL + 1)
        if len(payload) > MAX_PROTOCOL:
            raise ValueError("protocol bound")
        result = transform(json.loads(payload))
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
    except Exception as error:
        # Never echo source bytes, replacement text, or a traceback into diagnostics.
        reason = "preservation_unverified"
        if isinstance(error, EncodingEvidenceRequired):
            reason = "encoding_required"
        elif isinstance(error, CodecUnavailable):
            reason = "codec_unavailable"
        sys.stdout.buffer.write(json.dumps({"error": reason}).encode("ascii"))
        sys.exit(1)
