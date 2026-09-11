"""Synthetic codec and process fixtures; no user files, tools, or provider data."""
import base64
import builtins
import codecs
import ctypes
import errno
import io
import json
import os
import runpy
import subprocess
import sys
import unittest
from unittest.mock import patch


module = runpy.run_path(sys.argv.pop(1), run_name="codec_fixture")
scope = module["transform"].__globals__


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.calls = []

        def convert(executable, source, target, data):
            self.assertEqual(executable, os.path.abspath("/synthetic tools/iconv"))
            self.calls.append((source, target, data))
            source = "cp037" if source == "X-FIXTURE" else source
            target = "cp037" if target == "X-FIXTURE" else target
            return data.decode(source, "strict").encode(target, "strict")

        self.patches = [
            patch.dict(scope, {"run_iconv": convert}),
            patch.object(scope["shutil"], "which", return_value="/synthetic tools/iconv"),
        ]
        for item in self.patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    def transform(self, operation, source, **options):
        return module["transform"]({
            "operation": operation, "encoding": "X-FIXTURE",
            "source": base64.b64encode(source).decode("ascii"), **options,
        })

    def read(self, reader, source, **options):
        return reader.feed({"source": base64.b64encode(source).decode("ascii"), "encoding": "X-FIXTURE", **options})

    def test_decode_and_splice_preserve_mixed_endings_and_untouched_bytes(self):
        source = "café\r\ntarget\nlast\r".encode("cp037")
        self.assertEqual(self.transform("decode", source)["text"], "café\r\ntarget\nlast\r")
        result = self.transform("splice", source, splices=[{"start": 6, "end": 12, "replacement": "changed"}])
        self.assertEqual(base64.b64decode(result["bytes"]), "café\r\nchanged\nlast\r".encode("cp037"))
        self.assertTrue(self.calls)

    def test_incremental_read_retains_state_until_final_decode(self):
        reader = scope["ReadStream"]()
        first = self.read(reader, "café\r".encode("cp037"), final=False)
        second = self.read(reader, "\nlast".encode("cp037"), final=True)
        self.assertEqual(first["text"], "")
        self.assertEqual(second["text"], "café\r\nlast")
        self.assertNotIn("state", second)
        with self.assertRaises(ValueError):
            self.read(reader, b"", final=True)

    def test_unrepresentable_replacement_never_returns_bytes(self):
        # The bounded failure names the character and the codec; the raw encode error never escapes.
        with self.assertRaises(module["ReplacementUnrepresentable"]) as caught:
            self.transform("splice", b"\xa3\x81\x99\x87\x85\xa3", splices=[{"start": 0, "end": 6, "replacement": "🙂"}])
        self.assertEqual(caught.exception.character, "🙂")
        self.assertEqual(module["failure_reason"](caught.exception), "replacement_unrepresentable")

    def test_lossy_success_is_rejected_by_independent_text_verification(self):
        convert = scope["run_iconv"]

        def lossy(executable, source, target, data):
            if target == "X-FIXTURE":
                data = data.replace("🙂".encode(), b"?")
            return convert(executable, source, target, data)

        with patch.dict(scope, {"run_iconv": lossy}):
            with self.assertRaises(ValueError):
                self.transform("splice", "target".encode("cp037"), splices=[{"start": 0, "end": 6, "replacement": "🙂"}])

    def test_noncanonical_source_roundtrip_is_rejected(self):
        convert = scope["run_iconv"]

        def mismatched(executable, source, target, data):
            result = convert(executable, source, target, data)
            return result + b"x" if target == "X-FIXTURE" else result

        with patch.dict(scope, {"run_iconv": mismatched}):
            with self.assertRaises(ValueError):
                self.transform("decode", "target".encode("cp037"))

    def test_native_codec_does_not_need_iconv(self):
        result = module["transform"]({"operation": "decode", "source": "6Q==", "encoding": "cp1252"})
        self.assertEqual(result["text"], "é")
        self.assertEqual(self.calls, [])

    def test_missing_ffi_does_not_disable_python_or_command_codecs(self):
        with patch.dict(scope, {"ctypes": None}):
            self.assertEqual(self.transform("decode", "target".encode("cp037"))["text"], "target")
            self.assertEqual(module["transform"]({"operation": "decode", "source": "6Q==", "encoding": "cp1252"})["text"], "é")
            with self.assertRaises(scope["CodecUnavailable"]):
                scope["NativeIconv"]()

    def test_helper_import_recovers_when_python_was_built_without_ffi(self):
        original = builtins.__import__

        def import_without_ffi(name, *args, **kwargs):
            if name == "ctypes":
                raise ImportError("synthetic absent FFI")
            return original(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=import_without_ffi):
            isolated = runpy.run_path(module["__file__"], run_name="minimal_python_fixture")
            self.assertEqual(isolated["transform"]({"operation": "decode", "source": "6Q==", "encoding": "cp1252"})["text"], "é")

    def test_missing_iconv_and_unsafe_labels_do_not_guess(self):
        with patch.object(scope["shutil"], "which", return_value=None), patch.dict(scope, {"NativeIconv": unittest.mock.Mock(side_effect=scope["CodecUnavailable"]("fixture unavailable"))}):
            with self.assertRaises(LookupError):
                self.transform("decode", b"text")
        for encoding in ("X-FIXTURE//IGNORE", "X-FIXTURE//TRANSLIT", "-f", "X-FIXTURE\0", "X-FIXTURE;echo"):
            # CPython rejects embedded NUL as ValueError before lookup can miss.
            with self.subTest(encoding=encoding), self.assertRaises((LookupError, ValueError)):
                module["transform"]({"operation": "decode", "source": "dGV4dA==", "encoding": encoding})
        self.assertEqual(self.calls, [])

    def test_bom_conflict_rejects_before_conversion(self):
        with self.assertRaises(ValueError):
            self.transform("decode", codecs.BOM_UTF16_LE + "target".encode("utf-16-le"))
        self.assertEqual(self.calls, [])

    def test_pending_read_bytes_are_bounded_and_lifecycle_is_validated(self):
        with patch.dict(scope, {"MAX_SOURCE": 4}):
            reader = scope["ReadStream"]()
            self.read(reader, b"123", final=False)
            with self.assertRaises(ValueError):
                self.read(reader, b"123", final=False)
        with self.assertRaises(ValueError):
            self.read(scope["ReadStream"](), b"", final=1)

    def test_lossy_decode_cannot_be_presented_as_a_successful_read(self):
        convert = scope["run_iconv"]

        def substituted(executable, source, target, data):
            return b"?" if source == "X-FIXTURE" else convert(executable, source, target, data)

        with patch.dict(scope, {"run_iconv": substituted}):
            with self.assertRaises(ValueError):
                self.read(scope["ReadStream"](), "é".encode("cp037"), final=True)


class ReadProtocolTests(unittest.TestCase):
    def serve(self, payload):
        stdin = unittest.mock.Mock(buffer=io.BytesIO(payload))
        stdout = unittest.mock.Mock(buffer=io.BytesIO())
        with patch.object(scope["sys"], "stdin", stdin), patch.object(scope["sys"], "stdout", stdout):
            code = scope["serve_read_stream"]()
        return code, [json.loads(line) for line in stdout.buffer.getvalue().splitlines()]

    def frame(self, sequence, source=b"", **options):
        return json.dumps({
            "sequence": sequence, "final": False, "encoding": "utf-16-le",
            "source": base64.b64encode(source).decode("ascii"), **options,
        }).encode("ascii") + b"\n"

    def test_incomplete_character_state_survives_frames_without_serialization(self):
        source = "café🙂\r\n".encode("utf-16-le")
        code, frames = self.serve(self.frame(0, source[:9]) + self.frame(1, source[9:], final=True))
        self.assertEqual(code, 0)
        self.assertEqual([frame["sequence"] for frame in frames], [0, 1])
        self.assertEqual([frame["final"] for frame in frames], [False, True])
        self.assertEqual("".join(frame["text"] for frame in frames), "café🙂\r\n")
        self.assertTrue(all("state" not in frame for frame in frames))

    def test_malformed_truncated_and_wrong_sequence_frames_are_bounded_diagnostics(self):
        for payload in (b"", b"FIXTURE_PRIVATE_TEXT\n", b"{}", b"[]\n", self.frame(1), self.frame(True)):
            with self.subTest(payload=payload):
                code, frames = self.serve(payload)
                self.assertEqual(code, 1)
                self.assertEqual(frames, [{"sequence": 0, "final": False, "error": "preservation_unverified"}])

    def test_replay_and_changed_encoding_reject_after_a_valid_frame(self):
        for second in (self.frame(0), self.frame(1, encoding="utf-8")):
            code, frames = self.serve(self.frame(0, b"a\0") + second)
            self.assertEqual(code, 1)
            self.assertEqual(frames[0]["text"], "a")
            self.assertEqual(frames[1], {"sequence": 1, "final": False, "error": "preservation_unverified"})

    def test_partial_final_character_never_produces_success(self):
        code, frames = self.serve(self.frame(0, b"a", final=True))
        self.assertEqual(code, 1)
        self.assertEqual(frames, [{"sequence": 0, "final": True, "error": "preservation_unverified"}])

    def test_frame_size_is_enforced_before_decoding(self):
        with patch.dict(scope, {"MAX_PROTOCOL": 16}):
            code, frames = self.serve(self.frame(0, b"a\0", final=True))
        self.assertEqual(code, 1)
        self.assertEqual(frames, [{"sequence": 0, "final": False, "error": "preservation_unverified"}])


class NativeTransportTests(unittest.TestCase):
    def setUp(self):
        self.steps = []
        self.inputs = []
        self.library = unittest.mock.Mock()
        self.library.iconv_open.return_value = 7
        self.library.iconv_close.return_value = 0
        self.library.iconv.side_effect = self.convert_buffer
        loaded = patch.object(ctypes, "CDLL", return_value=self.library)
        self.load = loaded.start()
        self.addCleanup(loaded.stop)
        self.native = scope["NativeIconv"]()

    def convert_buffer(self, descriptor, source, source_left, output, output_left):
        self.assertEqual(descriptor, 7)
        step = self.steps.pop(0)
        if source is None:
            self.inputs.append(None)
        else:
            pointer = ctypes.cast(source, ctypes.POINTER(ctypes.c_void_p)).contents
            left = ctypes.cast(source_left, ctypes.POINTER(ctypes.c_size_t)).contents
            self.inputs.append(ctypes.string_at(pointer.value, left.value))
            consumed = step.get("consumed", left.value)
            pointer.value += consumed
            left.value -= consumed
        pointer = ctypes.cast(output, ctypes.POINTER(ctypes.c_void_p)).contents
        left = ctypes.cast(output_left, ctypes.POINTER(ctypes.c_size_t)).contents
        payload = step.get("output", b"")
        self.assertLessEqual(len(payload), left.value)
        ctypes.memmove(pointer.value, payload, len(payload))
        pointer.value += len(payload)
        left.value -= len(payload)
        ctypes.set_errno(step.get("errno", 0))
        return step.get("result", 0)

    def test_binary_buffers_flush_and_native_abi(self):
        self.steps = [{"output": b"a\0b"}, {"output": b"!"}]
        self.assertEqual(self.native.convert("X-SOURCE", "X-TARGET", b"a\0b"), b"a\0b!")
        self.assertEqual(self.inputs, [b"a\0b", None])
        self.load.assert_called_once_with(None, use_errno=True)
        self.library.iconv_open.assert_called_once_with(b"X-TARGET", b"X-SOURCE")
        self.library.iconv_close.assert_called_once_with(7)
        self.assertEqual(self.library.iconv.restype, ctypes.c_size_t)
        self.assertEqual(self.library.iconv_open.restype, ctypes.c_void_p)
        self.assertEqual(len(self.library.iconv.argtypes), 5)

    def test_output_exhaustion_resumes_at_exact_source_pointer_and_flushes(self):
        self.steps = [
            {"output": b"first", "consumed": 1, "result": ctypes.c_size_t(-1).value, "errno": errno.E2BIG},
            {"output": b"second"},
            {"output": b"tail", "result": ctypes.c_size_t(-1).value, "errno": errno.E2BIG},
            {},
        ]
        self.assertEqual(self.native.convert("a", "b", b"xy"), b"firstsecondtail")
        self.assertEqual(self.inputs, [b"xy", b"y", None, None])
        self.library.iconv_close.assert_called_once_with(7)

    def test_input_and_output_bounds_close_only_admitted_descriptors(self):
        with patch.dict(scope, {"MAX_ICONV_OUTPUT": 4}):
            with self.assertRaises(ValueError):
                self.native.convert("a", "b", b"12345")
            self.library.iconv_open.assert_not_called()
            self.steps = [{"output": b"12345"}]
            with self.assertRaises(ValueError):
                self.native.convert("a", "b", b"x")
            self.library.iconv_close.assert_called_once_with(7)

    def test_invalid_incomplete_and_nonreversible_results_never_return_bytes(self):
        for result, error in ((ctypes.c_size_t(-1).value, errno.EILSEQ), (ctypes.c_size_t(-1).value, errno.EINVAL), (1, 0)):
            with self.subTest(result=result, error=error):
                self.library.iconv_close.reset_mock()
                self.steps = [{"output": b"partial", "result": result, "errno": error}]
                with self.assertRaises(ValueError):
                    self.native.convert("a", "b", b"x")
                self.library.iconv_close.assert_called_once_with(7)

    def test_no_progress_does_not_loop(self):
        self.steps = [{"consumed": 0, "result": ctypes.c_size_t(-1).value, "errno": errno.E2BIG}]
        with self.assertRaises(ValueError):
            self.native.convert("a", "b", b"x")
        self.library.iconv.assert_called_once()
        self.library.iconv_close.assert_called_once_with(7)

    def test_open_failure_never_closes_an_invalid_descriptor(self):
        self.library.iconv_open.return_value = ctypes.c_void_p(-1).value
        with self.assertRaises(LookupError):
            self.native.convert("a", "b", b"x")
        self.library.iconv.assert_not_called()
        self.library.iconv_close.assert_not_called()

    def test_unsupported_native_codec_has_availability_guidance_not_data_loss_guidance(self):
        self.library.iconv_open.return_value = ctypes.c_void_p(-1).value
        for code, reason in ((errno.EINVAL, "codec_unavailable"), (errno.EMFILE, "preservation_unverified")):
            with self.subTest(errno=code), patch.object(ctypes, "get_errno", return_value=code):
                with self.assertRaises(LookupError) as caught:
                    self.native.convert("X-FIXTURE", "UTF-8", b"synthetic")
                self.assertEqual(module["failure_reason"](caught.exception), reason)
        self.library.iconv.assert_not_called()
        self.library.iconv_close.assert_not_called()

    def test_allocation_failure_closes_the_descriptor(self):
        failure = MemoryError("synthetic allocation failure")
        with patch.object(ctypes, "create_string_buffer", side_effect=failure):
            with self.assertRaises(MemoryError) as caught:
                self.native.convert("a", "b", b"x")
        self.assertIs(caught.exception, failure)
        self.library.iconv_close.assert_called_once_with(7)

    def test_close_failure_cannot_replace_conversion_failure_or_claim_success(self):
        failure = ValueError("synthetic conversion failure")
        self.library.iconv_close.return_value = -1
        self.library.iconv.side_effect = failure
        with self.assertRaises(ValueError) as caught:
            self.native.convert("a", "b", b"x")
        self.assertIs(caught.exception, failure)
        self.library.iconv.side_effect = self.convert_buffer
        self.steps = [{"output": b"x"}, {}]
        with self.assertRaisesRegex(ValueError, "close failed"):
            self.native.convert("a", "b", b"x")

    def test_deadline_closes_without_starting_another_conversion(self):
        with patch.object(scope["time"], "monotonic", side_effect=[0, scope["ICONV_TIMEOUT"]]):
            with self.assertRaisesRegex(ValueError, "deadline"):
                self.native.convert("a", "b", b"x")
        self.library.iconv.assert_not_called()
        self.library.iconv_close.assert_called_once_with(7)

    def test_missing_symbols_are_unavailable_not_guessed_library_paths(self):
        self.load.return_value = object()
        with self.assertRaises(scope["CodecUnavailable"]):
            scope["NativeIconv"]()
        self.assertTrue(all(call.args == (None,) for call in self.load.call_args_list))

    def test_incomplete_success_and_invalid_counts_are_rejected(self):
        for consumed in (0, -1):
            self.steps = [{"consumed": consumed}]
            with self.subTest(consumed=consumed), self.assertRaises(ValueError):
                self.native.convert("a", "b", b"x")
        self.assertEqual(self.library.iconv_close.call_count, 2)


class ProcessTests(unittest.TestCase):
    def test_bounded_argv_execution_and_failed_exit(self):
        for code, data in ((0, b"converted"), (1, b"partial"), (0, b"x" * 33)):
            with self.subTest(code=code, size=len(data)):
                child = unittest.mock.Mock()
                child.stdin = io.BytesIO()
                child.stdout = io.BytesIO(data)
                child.wait.return_value = code
                with patch.object(scope["subprocess"], "Popen", return_value=child) as spawn, patch.dict(scope, {"MAX_ICONV_OUTPUT": 32}):
                    if code == 0 and len(data) <= 32:
                        self.assertEqual(module["run_iconv"]("/synthetic tools/iconv", "X-FIXTURE", "UTF-8", b"input"), data)
                    else:
                        with self.assertRaises(ValueError):
                            module["run_iconv"]("/synthetic tools/iconv", "X-FIXTURE", "UTF-8", b"input")
                    self.assertEqual(spawn.call_args.args[0], ["/synthetic tools/iconv", "-f", "X-FIXTURE", "-t", "UTF-8"])
                    self.assertEqual(spawn.call_args.kwargs["stderr"], subprocess.DEVNULL)
                    self.assertNotIn("shell", spawn.call_args.kwargs)
                    self.assertTrue(child.wait.called)

    def test_deadline_kills_and_reaps_before_returning_failure(self):
        child = unittest.mock.Mock()
        child.stdin = io.BytesIO()
        child.stdout = io.BytesIO(b"partial")
        child.wait.return_value = 0
        timer = unittest.mock.Mock()

        def create_timer(_seconds, expire):
            timer.start.side_effect = expire
            return timer

        with patch.object(scope["subprocess"], "Popen", return_value=child), patch.object(scope["threading"], "Timer", side_effect=create_timer):
            with self.assertRaises(ValueError):
                module["run_iconv"]("/synthetic tools/iconv", "X-FIXTURE", "UTF-8", b"input")
        self.assertTrue(child.kill.called)
        self.assertTrue(child.wait.called)
        timer.cancel.assert_called_once()
        timer.join.assert_called_once()

    def test_spawn_failure_is_not_success_or_a_codec_guess(self):
        failure = OSError("synthetic unavailable converter")
        with patch.object(scope["subprocess"], "Popen", side_effect=failure):
            with self.assertRaises(OSError) as caught:
                module["run_iconv"]("/synthetic tools/iconv", "X-FIXTURE", "UTF-8", b"input")
        self.assertIs(caught.exception, failure)


if "--native-library" in sys.argv:
    # Independent ABI probe: no executable lookup and no production adapter involved.
    try:
        library = ctypes.CDLL(None)
        opened = library.iconv_open
        closed = library.iconv_close
        opened.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        opened.restype = ctypes.c_void_p
        closed.argtypes = [ctypes.c_void_p]
        closed.restype = ctypes.c_int
        descriptor = opened(b"UTF-8", b"IBM1047")
        available = descriptor != ctypes.c_void_p(-1).value
        if available:
            assert closed(descriptor) == 0
    except (AttributeError, OSError, TypeError):
        available = False
    if available:
        with patch.object(scope["shutil"], "which", return_value=None):
            request = {"operation": "decode", "encoding": "IBM1047", "source": "o4GZh4WjDSU="}
            assert module["transform"](request)["text"] == "target\r\n"
            request.update(operation="splice", splices=[{"start": 0, "end": 6, "replacement": "changed"}])
            assert base64.b64decode(module["transform"](request)["bytes"]) == bytes.fromhex("838881958785840d25")
        native = scope["NativeIconv"]()
        text = "é🙂" * 100_000
        assert native.convert("UTF-8", "UTF-16LE", text.encode("utf-8")) == text.encode("utf-16-le")
        assert native.convert("UTF-8", "UTF-16LE", b"") == b""
    print(json.dumps({"available": available}))
    sys.exit(0)

suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
print(json.dumps({
    "passed": result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped),
    "tests": result.testsRun, "skipped": len(result.skipped),
}))
sys.exit(0 if result.wasSuccessful() else 1)
