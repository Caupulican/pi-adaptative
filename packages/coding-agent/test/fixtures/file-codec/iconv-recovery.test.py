"""Synthetic codec and process fixtures; no user files, tools, or provider data."""
import base64
import codecs
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

    def test_decode_and_splice_preserve_mixed_endings_and_untouched_bytes(self):
        source = "café\r\ntarget\nlast\r".encode("cp037")
        self.assertEqual(self.transform("decode", source)["text"], "café\r\ntarget\nlast\r")
        result = self.transform("splice", source, splices=[{"start": 6, "end": 12, "replacement": "changed"}])
        self.assertEqual(base64.b64decode(result["bytes"]), "café\r\nchanged\nlast\r".encode("cp037"))
        self.assertTrue(self.calls)

    def test_incremental_read_retains_state_until_final_decode(self):
        first = self.transform("read_chunk", "café\r".encode("cp037"), final=False)
        second = self.transform("read_chunk", "\nlast".encode("cp037"), final=True, state=first["state"])
        self.assertEqual(first["text"], "")
        self.assertEqual(second["text"], "café\r\nlast")
        self.assertEqual(second["state"], ["", 0])

    def test_unrepresentable_replacement_never_returns_bytes(self):
        with self.assertRaises(UnicodeEncodeError):
            self.transform("splice", b"\xa3\x81\x99\x87\x85\xa3", splices=[{"start": 0, "end": 6, "replacement": "🙂"}])

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

    def test_missing_iconv_and_unsafe_labels_do_not_guess(self):
        with patch.object(scope["shutil"], "which", return_value=None):
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

    def test_pending_read_bytes_are_bounded_and_state_is_validated(self):
        with patch.dict(scope, {"MAX_SOURCE": 4}):
            with self.assertRaises(ValueError):
                self.transform("read_chunk", b"123", final=False, state=["MTIz", 0])
        with self.assertRaises(ValueError):
            self.transform("read_chunk", b"", final=True, state=["", 1])

    def test_lossy_decode_cannot_be_presented_as_a_successful_read(self):
        convert = scope["run_iconv"]

        def substituted(executable, source, target, data):
            return b"?" if source == "X-FIXTURE" else convert(executable, source, target, data)

        with patch.dict(scope, {"run_iconv": substituted}):
            with self.assertRaises(ValueError):
                self.transform("read_chunk", "é".encode("cp037"), final=True)


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


suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
result = unittest.TextTestRunner(stream=sys.stderr, verbosity=2).run(suite)
print(json.dumps({
    "passed": result.testsRun - len(result.failures) - len(result.errors) - len(result.skipped),
    "tests": result.testsRun, "skipped": len(result.skipped),
}))
sys.exit(0 if result.wasSuccessful() else 1)
