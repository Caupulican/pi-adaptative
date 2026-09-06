"""Pure byte/text codec for managed reads and edits. No target paths or executable input.

Matching and newline policy belong to the TypeScript edit planner. This helper
validates its source-coordinate splices, preserves untouched source bytes, and
encodes only replacements with the same strict codec. Read-only incremental
decoding carries codec state between bounded chunks, without edit round-trip
requirements. BOM/encoding selection is shared. This helper never writes a file.
"""
import base64
import codecs
import errno
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

try:
    import ctypes
except ImportError:
    # Minimal Python builds may omit the native FFI; existing codecs/CLI still work.
    ctypes = None

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


class NativeIconv:
    """Use already-loaded POSIX iconv symbols, never search or guess a library path.

    Each conversion owns one descriptor. Bounded output and progress checks cover
    cooperative calls; the outer isolated-helper deadline also bounds a stuck C call.
    """
    def __init__(self):
        if ctypes is None:
            raise CodecUnavailable("native iconv FFI unavailable")
        try:
            library = ctypes.CDLL(None, use_errno=True)
            self.open = library.iconv_open
            self.convert_buffer = library.iconv
            self.close = library.iconv_close
        except (AttributeError, OSError, TypeError) as cause:
            raise CodecUnavailable("native iconv unavailable") from cause
        self.open.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        self.open.restype = ctypes.c_void_p
        self.convert_buffer.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_size_t),
        ]
        self.convert_buffer.restype = ctypes.c_size_t
        self.close.argtypes = [ctypes.c_void_p]
        self.close.restype = ctypes.c_int

    def convert(self, source_encoding, target_encoding, data):
        if len(data) > MAX_ICONV_OUTPUT:
            raise ValueError("iconv input bound")
        deadline = time.monotonic() + ICONV_TIMEOUT
        descriptor = self.open(target_encoding.encode("ascii"), source_encoding.encode("ascii"))
        if descriptor == ctypes.c_void_p(-1).value:
            raise LookupError("native iconv conversion unavailable")
        try:
            source = ctypes.create_string_buffer(data)
            source_pointer = ctypes.c_void_p(ctypes.addressof(source))
            source_left = ctypes.c_size_t(len(data))
            converted = bytearray()
            flush = False
            while True:
                if time.monotonic() >= deadline:
                    raise ValueError("native iconv deadline")
                capacity = min(64 * 1024, MAX_ICONV_OUTPUT - len(converted) + 1)
                output = ctypes.create_string_buffer(capacity)
                output_pointer = ctypes.c_void_p(ctypes.addressof(output))
                output_left = ctypes.c_size_t(capacity)
                before = source_left.value
                result = self.convert_buffer(
                    descriptor, None if flush else ctypes.byref(source_pointer),
                    None if flush else ctypes.byref(source_left),
                    ctypes.byref(output_pointer), ctypes.byref(output_left),
                )
                produced = capacity - output_left.value
                if not 0 <= produced <= capacity or not 0 <= source_left.value <= before:
                    raise ValueError("invalid native iconv counts")
                if len(converted) + produced > MAX_ICONV_OUTPUT:
                    raise ValueError("iconv output bound")
                if produced:
                    converted.extend(output.raw[:produced])
                if result == ctypes.c_size_t(-1).value:
                    if ctypes.get_errno() != errno.E2BIG or (produced == 0 and source_left.value == before):
                        raise ValueError("native iconv conversion unverified")
                elif result != 0 or source_left.value != 0:
                    raise ValueError("native iconv conversion was not exact")
                elif flush:
                    return bytes(converted)
                else:
                    flush = True
        finally:
            if self.close(descriptor) != 0 and sys.exc_info()[0] is None:
                raise ValueError("native iconv close failed")


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

class IconvCodec:
    def __init__(self, name):
        # Labels are data, not command options or iconv //IGNORE / //TRANSLIT directives.
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}", name):
            raise LookupError("unsupported codec label")
        executable = shutil.which("iconv")
        self.name = name
        self.executable = os.path.abspath(executable) if executable else None
        self.native = None if executable else NativeIconv()

    def convert(self, source, target, data):
        if self.native is not None:
            return self.native.convert(source, target, data)
        return run_iconv(self.executable, source, target, data)

    def encode(self, text, errors="strict"):
        if errors != "strict":
            raise ValueError("strict conversion required")
        encoded = self.convert("UTF-8", self.name, text.encode("utf-8", "strict"))
        # Some platform implementations substitute even without a lossy flag.
        if self.convert(self.name, "UTF-8", encoded).decode("utf-8", "strict") != text:
            raise ValueError("iconv changed replacement text")
        return encoded, len(text)

    def decode(self, source, errors="strict"):
        if errors != "strict":
            raise ValueError("strict conversion required")
        text = self.convert(self.name, "UTF-8", source).decode("utf-8", "strict")
        if self.convert("UTF-8", self.name, text.encode("utf-8", "strict")) != source:
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


def read_source(request):
    original = base64.b64decode(request["source"], validate=True)
    if len(original) > MAX_SOURCE:
        raise ValueError("source bound")
    return original


class ReadStream:
    """One read owns its decoder; opaque state never leaves this helper process."""
    def __init__(self):
        self.decoder = None
        self.encoding = None
        self.finished = False

    def feed(self, request):
        if self.finished or type(request["final"]) is not bool:
            raise ValueError("invalid read lifecycle")
        source = read_source(request)
        if self.decoder is None:
            _, self.encoding, source = select_encoding(source, request.get("encoding"))
            self.decoder = lookup_codec(self.encoding).incrementaldecoder(errors="strict")
        elif request.get("encoding") != self.encoding:
            raise ValueError("changed read encoding")
        text = self.decoder.decode(source, final=request["final"])
        if not isinstance(text, str) or "\0" in text:
            raise ValueError("not text")
        if len(self.decoder.getstate()[0]) > MAX_SOURCE:
            raise ValueError("decoder state bound")
        self.finished = request["final"]
        return {"text": text, "encoding": self.encoding}


def transform(request):
    original = read_source(request)
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


def failure_reason(error):
    # Never echo source bytes, replacement text, or a traceback into diagnostics.
    if isinstance(error, EncodingEvidenceRequired):
        return "encoding_required"
    if isinstance(error, CodecUnavailable):
        return "codec_unavailable"
    return "preservation_unverified"


def serve_read_stream():
    reader = ReadStream()
    sequence = 0
    while not reader.finished:
        final = False
        try:
            payload = sys.stdin.buffer.readline(MAX_PROTOCOL + 1)
            if len(payload) > MAX_PROTOCOL or not payload.endswith(b"\n"):
                raise ValueError("invalid read frame")
            request = json.loads(payload)
            final = request.get("final", False)
            if type(request.get("sequence")) is not int or request["sequence"] != sequence:
                raise ValueError("invalid read sequence")
            result = reader.feed(request)
            result.update(sequence=sequence, final=final)
            output = json.dumps(result, ensure_ascii=True).encode("ascii") + b"\n"
            if len(output) > MAX_PROTOCOL:
                raise ValueError("read output bound")
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
            sequence += 1
        except Exception as error:
            output = {"sequence": sequence, "final": final, "error": failure_reason(error)}
            sys.stdout.buffer.write(json.dumps(output).encode("ascii") + b"\n")
            sys.stdout.buffer.flush()
            return 1
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--read-stream"]:
        sys.exit(serve_read_stream())
    try:
        payload = sys.stdin.buffer.read(MAX_PROTOCOL + 1)
        if len(payload) > MAX_PROTOCOL:
            raise ValueError("protocol bound")
        result = transform(json.loads(payload))
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True).encode("ascii"))
    except Exception as error:
        sys.stdout.buffer.write(json.dumps({"error": failure_reason(error)}).encode("ascii"))
        sys.exit(1)
