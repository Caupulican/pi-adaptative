"""Pure byte/text codec for managed reads and edits. No target paths or executable input.

Matching and newline policy belong to the TypeScript edit planner. This helper
validates its source-coordinate splices, preserves untouched source bytes, and
encodes only replacements with the same strict codec. Read-only incremental
decoding carries codec state between bounded chunks, without edit round-trip
requirements. BOM/encoding selection and detection are shared by every path, so a
source handed over at once and the same source streamed in chunks resolve
identically. This helper never writes a file.
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


# The five positions windows-1252 leaves undefined; a file using them is ISO-8859-1, not 1252.
CP1252_UNDEFINED = (0x81, 0x8D, 0x8F, 0x90, 0x9D)
CP1252_UNDEFINED_BYTES = bytes(CP1252_UNDEFINED)
# UTF-16 text is at least this much NUL, and its NULs sit on one parity of byte offsets.
MIN_UTF16_NUL_SHARE = 0.30
MIN_UTF16_NUL_ALIGNMENT = 0.90
MAX_BOM_BYTES = max(len(marker) for marker, _ in BOMS)


class EncodingEvidenceRequired(ValueError):
    pass


class ReplacementUnrepresentable(ValueError):
    """One replacement character the resolved codec has no byte for; reported before any output."""
    def __init__(self, character, encoding):
        super().__init__("replacement unrepresentable")
        self.character = character
        self.encoding = encoding


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
            if ctypes.get_errno() == errno.EINVAL:
                raise CodecUnavailable("native iconv codec unavailable")
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


class EncodingDetector:
    """Incremental evidence for a source nothing declares.

    Keeps counters and strict incremental decoder state, never the bytes, so one whole source and
    the same source streamed in bounded chunks reach the same verdict. Detection is deterministic
    and dependency-free: the two BOM-less UTF-16 byte orders by NUL density and parity, then strict
    UTF-8, then the single-byte family the legacy Windows toolchains actually emit. Anything else is
    reported as missing evidence rather than decoded under a guess.
    """

    CANDIDATES = ("utf-8", "utf-16-le", "utf-16-be", "windows-1252", "latin-1")

    def __init__(self):
        self.length = 0
        self.nuls = 0
        self.odd_nuls = 0
        self.undefined_seen = False
        self.finished = False
        self.decoders = {}
        self.rejected = set()
        for name in self.CANDIDATES:
            try:
                self.decoders[name] = codecs.lookup(name).incrementaldecoder(errors="strict")
            except LookupError:
                self.rejected.add(name)
        # windows-1252 with its five undefined positions removed: ISO-8859-1 is the total codec, so
        # it is accepted only when those positions are the whole difference.
        try:
            self.defined = codecs.lookup("windows-1252").incrementaldecoder(errors="strict")
        except LookupError:
            self.defined = None

    def feed(self, chunk, final=False):
        if self.finished:
            raise ValueError("invalid detect lifecycle")
        self.nuls += chunk.count(0)
        # NULs at odd offsets of the WHOLE source, so a chunk boundary cannot shift the parity.
        self.odd_nuls += chunk[(1 if self.length % 2 == 0 else 0)::2].count(0)
        if not self.undefined_seen:
            self.undefined_seen = any(byte in chunk for byte in CP1252_UNDEFINED)
        self.length += len(chunk)
        for name, decoder in self.decoders.items():
            if name in self.rejected:
                continue
            try:
                decoder.decode(chunk, final)
            except (UnicodeDecodeError, ValueError):
                self.rejected.add(name)
        if self.defined is not None:
            try:
                self.defined.decode(chunk.translate(None, CP1252_UNDEFINED_BYTES), final)
            except (UnicodeDecodeError, ValueError):
                self.defined = None
        self.finished = final

    def resolve(self):
        if not self.finished:
            raise ValueError("detection is incomplete")
        # NUL first: this helper decodes text, and a NUL that is not UTF-16 padding means the source
        # is binary or ambiguous, even when its bytes happen to satisfy strict UTF-8.
        if self.nuls:
            encoding = self.resolve_utf16()
            if encoding is None:
                raise EncodingEvidenceRequired("ambiguous NUL-bearing source")
            return encoding
        if "utf-8" not in self.rejected:
            return "utf-8"
        if "windows-1252" not in self.rejected:
            return "windows-1252"
        if self.undefined_seen and self.defined is not None and "latin-1" not in self.rejected:
            return "latin-1"
        raise EncodingEvidenceRequired("undetectable single-byte source")

    def resolve_utf16(self):
        """BOM-less UTF-16 is NUL-dense and parity-aligned; nothing here guesses a charset."""
        if self.nuls < self.length * MIN_UTF16_NUL_SHARE:
            return None
        for aligned, encoding in ((self.odd_nuls, "utf-16-le"), (self.nuls - self.odd_nuls, "utf-16-be")):
            if aligned >= self.nuls * MIN_UTF16_NUL_ALIGNMENT and encoding not in self.rejected:
                return encoding
        return None


def detect_encoding(source):
    """Resolve one whole source through the same detector a streamed source is resolved with."""
    detector = EncodingDetector()
    detector.feed(source, True)
    return detector.resolve()


def match_bom(head):
    """The byte-order mark the source opens with, if any. A short head simply matches fewer."""
    return next(((marker, name) for marker, name in BOMS if head.startswith(marker)), (b"", None))


def select_encoding(original, requested):
    bom, marked = match_bom(original)
    # The canonical spelling settles the BOM and byte-order checks; the response reports the
    # encoding under the name the caller or the detector used, so a resolved name means the same
    # codec when a later call sends it back.
    canonical = lookup_codec(requested).name if requested else None
    encoding = requested or marked
    detected = False
    if not encoding:
        encoding = detect_encoding(original)
        detected = True
    if marked:
        if canonical is not None and canonical not in (
            marked, marked.rsplit("-", 1)[0], "utf-8-sig" if marked == "utf-8" else marked
        ):
            raise ValueError("encoding conflicts with BOM")
        encoding = marked
    elif canonical in ("utf-16", "utf-32", "utf-8-sig"):
        raise ValueError("codec requires BOM or explicit byte order")
    return bom, encoding, original[len(bom):], detected


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
        self.detected = False
        self.finished = False

    def feed(self, request):
        if self.finished or type(request["final"]) is not bool:
            raise ValueError("invalid read lifecycle")
        source = read_source(request)
        if self.decoder is None:
            _, self.encoding, source, self.detected = select_encoding(source, request.get("encoding"))
            self.decoder = lookup_codec(self.encoding).incrementaldecoder(errors="strict")
        elif request.get("encoding") != self.encoding:
            # After a resolution the caller echoes the encoding it was given; a different one
            # would change codec mid-stream and silently reinterpret the bytes already decoded.
            raise ValueError("changed read encoding")
        text = self.decoder.decode(source, final=request["final"])
        if not isinstance(text, str) or "\0" in text:
            raise ValueError("not text")
        if len(self.decoder.getstate()[0]) > MAX_SOURCE:
            raise ValueError("decoder state bound")
        self.finished = request["final"]
        return {"text": text, "encoding": self.encoding, "detected": self.detected}


class DetectStream:
    """Whole-source detection over bounded frames, answered on the final frame.

    A streamed decode sees one bounded chunk at a time, so a codec chosen from the first chunk can
    be contradicted by the last one. This pass reads every byte and keeps none of them.
    """

    def __init__(self):
        self.head = b""
        self.marked = None
        self.finished = False
        self.detector = EncodingDetector()

    def feed(self, request):
        if self.finished or type(request["final"]) is not bool:
            raise ValueError("invalid detect lifecycle")
        final = request["final"]
        source = read_source(request)
        if self.head is not None:
            # A byte-order mark can straddle the first frames, so nothing is judged before the
            # source has the four bytes the longest mark needs (or has ended).
            self.head += source
            if len(self.head) < MAX_BOM_BYTES and not final:
                return None
            _, self.marked = match_bom(self.head)
            source = self.head
            self.head = None
        # A mark settles the encoding exactly as it does for a whole source handed over at once,
        # and the bytes behind it are then evidence for nothing. A mark is the file declaring its
        # own encoding, so it is reported as a declaration, never as this helper's detection.
        if self.marked is None:
            self.detector.feed(source, final)
        self.finished = final
        if not final:
            return None
        if self.marked is not None:
            return {"encoding": self.marked, "detected": False}
        return {"encoding": self.detector.resolve(), "detected": True}


class ReadSession:
    """One read owns one helper: the optional whole-source detection pass, then the decode stream."""

    def __init__(self):
        self.detection = None
        self.stream = ReadStream()

    @property
    def finished(self):
        return self.stream.finished

    def feed(self, request):
        operation = request.get("operation", "decode")
        if operation == "decode":
            return self.stream.feed(request)
        if operation != "detect":
            raise ValueError("unknown read operation")
        if self.stream.decoder is not None:
            raise ValueError("invalid read lifecycle")
        if self.detection is None:
            self.detection = DetectStream()
        resolved = self.detection.feed(request)
        return {} if resolved is None else resolved


def encode_replacement(codec, encoding, replacement):
    """Encode one replacement, naming the first character the codec has no bytes for.

    Every codec kind answers with the same bounded failure. A Python codec raises UnicodeEncodeError
    about the replacement itself and carries the offset; an iconv transport reports a failure of its
    own, about text the caller never wrote, so the offending character is located by bisection
    instead of read out of a foreign error. No encode failure leaves here as itself: the caller is
    told which character to change, never handed a codec's internals. An unavailable codec is not an
    encode failure and keeps its own diagnostic.
    """
    try:
        return codec.encode(replacement, "strict")[0]
    except CodecUnavailable:
        raise
    except UnicodeEncodeError as error:
        reported = isinstance(error.object, str) and error.object == replacement
        character = (
            error.object[error.start]
            if reported and 0 <= error.start < len(replacement)
            else locate_unrepresentable(codec, replacement)
        )
        raise ReplacementUnrepresentable(character, encoding) from error
    except (ValueError, LookupError) as error:
        raise ReplacementUnrepresentable(locate_unrepresentable(codec, replacement), encoding) from error


def locate_unrepresentable(codec, replacement):
    """Bounded bisection for codecs that report a failure without an offset (iconv transports).

    Only an encoding failure narrows the span. A codec that has become unavailable mid-bisection is
    an availability failure with its own remedy, so it is never reported as a character the caller
    could have written differently.
    """
    low, high = 0, len(replacement)
    while high - low > 1:
        middle = (low + high) // 2
        try:
            codec.encode(replacement[:middle], "strict")
        except CodecUnavailable:
            raise
        except (UnicodeEncodeError, ValueError, LookupError):
            high = middle
        else:
            low = middle
    return replacement[low:high]


def transform(request):
    original = read_source(request)
    bom, encoding, source, detected = select_encoding(original, request.get("encoding"))
    codec = lookup_codec(encoding)
    text = codec.decode(source, "strict")[0]
    if not isinstance(text, str) or "\0" in text or codec.encode(text, "strict")[0] != source:
        raise ValueError("source does not round-trip as text")
    if request["operation"] == "decode":
        return {"text": text, "encoding": encoding, "detected": detected}
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
        encoded = encode_replacement(codec, encoding, replacement)
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
    return {"bytes": base64.b64encode(result).decode("ascii"), "encoding": encoding, "detected": detected}


def failure_reason(error):
    # Never echo source bytes, whole replacements, or a traceback into diagnostics.
    if isinstance(error, EncodingEvidenceRequired):
        return "encoding_required"
    if isinstance(error, CodecUnavailable):
        return "codec_unavailable"
    if isinstance(error, ReplacementUnrepresentable):
        return "replacement_unrepresentable"
    return "preservation_unverified"


def failure_detail(error):
    """The one character the caller must change, plus the codec that rejected it."""
    if isinstance(error, ReplacementUnrepresentable):
        return {"character": error.character, "encoding": error.encoding}
    return None


def serve_read_stream():
    session = ReadSession()
    sequence = 0
    while not session.finished:
        final = False
        try:
            payload = sys.stdin.buffer.readline(MAX_PROTOCOL + 1)
            if len(payload) > MAX_PROTOCOL or not payload.endswith(b"\n"):
                raise ValueError("invalid read frame")
            request = json.loads(payload)
            final = request.get("final", False)
            if type(request.get("sequence")) is not int or request["sequence"] != sequence:
                raise ValueError("invalid read sequence")
            result = session.feed(request)
            result.update(sequence=sequence, final=final)
            output = json.dumps(result, ensure_ascii=True).encode("ascii") + b"\n"
            if len(output) > MAX_PROTOCOL:
                raise ValueError("read output bound")
            sys.stdout.buffer.write(output)
            sys.stdout.buffer.flush()
            sequence += 1
        except Exception as error:
            output = {"sequence": sequence, "final": final, "error": failure_reason(error)}
            detail = failure_detail(error)
            if detail is not None:
                output["detail"] = detail
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
        failure = {"error": failure_reason(error)}
        detail = failure_detail(error)
        if detail is not None:
            failure["detail"] = detail
        sys.stdout.buffer.write(json.dumps(failure).encode("ascii"))
        sys.exit(1)
