import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("abi_authorize", Path(__file__).parents[2] / "scripts/abi-authorize.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Child:
    def __init__(self, body, status=0):
        self.stdout = io.BytesIO(body)
        self.status = status
        self.killed = False

    def wait(self):
        return self.status

    def poll(self):
        return self.status

    def kill(self):
        self.killed = True


class AuthorizeTests(unittest.TestCase):
    def test_pair_validation(self):
        self.assertEqual(module.pair_from_plaintext(bytearray(b'["key","secret"]')), ["key", "secret"])
        for bad in [b'[]', b'["key"]', b'["key",""]', b'["key","bad\\nsecret"]', b'null', b'{}', b'\xff']:
            with self.assertRaises((ValueError, TypeError)):
                module.pair_from_plaintext(bytearray(bad))

    def run_delivery(self, child, relay_error=False):
        calls = []
        captured = []

        def run(args, **kwargs):
            calls.append(args)
            if "input" in kwargs:
                captured.append(kwargs["input"])
                self.assertNotIn("key", " ".join(args))
                self.assertNotIn("secret", " ".join(args))
                self.assertNotIn("env", kwargs)
                if relay_error:
                    raise subprocess.TimeoutExpired(args, 20)
                self.assertEqual(bytes(kwargs["input"]), b'{"v":1,"op":"authorize","credentials":["key","secret"]}\n')
                return subprocess.CompletedProcess(args, 0, b'{"v":1,"state":"AUTHORIZED","result":"accepted","extra":"secret"}')
            return subprocess.CompletedProcess(args, 0)

        with patch.object(module.subprocess, "run", side_effect=run), patch.object(module.subprocess, "Popen", return_value=child):
            if child.status or relay_error or len(child.stdout.getvalue()) > module.LIMIT:
                with self.assertRaises((ValueError, subprocess.TimeoutExpired)):
                    module.deliver("abi", "authorize", "credentials.age")
            else:
                safe = module.deliver("abi", "authorize", "credentials.age")
                self.assertEqual(safe, {"v": 1, "state": "AUTHORIZED", "result": "accepted"})
        self.assertTrue(child.stdout.closed)
        for frame in captured:
            self.assertFalse(any(frame))
        return calls

    def test_success_and_cleanup(self):
        self.assertEqual(len(self.run_delivery(Child(b'["key","secret"]'))), 2)

    def test_wrong_password_with_partial_plaintext_never_delivers(self):
        self.assertEqual(len(self.run_delivery(Child(b'["key","secret"]', 1))), 1)

    def test_oversized_plaintext_never_delivers(self):
        self.assertEqual(len(self.run_delivery(Child(b'x' * 5000))), 1)

    def test_relay_failure_clears_frame(self):
        self.run_delivery(Child(b'["key","secret"]'), relay_error=True)

    def test_swap_check_fails_before_decryption(self):
        with patch.object(module.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "docker")), patch.object(module.subprocess, "Popen") as age:
            with self.assertRaises(subprocess.CalledProcessError):
                module.deliver("abi", "authorize", "credentials.age")
            age.assert_not_called()

    def test_status_never_decrypts(self):
        with patch.object(module.subprocess, "Popen") as age, patch.object(module.subprocess, "run", side_effect=[
            subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0, b'{"v":1,"state":"LOCKED"}')
        ]) as run:
            self.assertEqual(module.deliver("abi", "status"), {"v": 1, "state": "LOCKED"})
            age.assert_not_called()
            self.assertEqual(bytes(run.call_args.kwargs["input"]), b'\0' * len(b'{"v":1,"op":"status"}\n'))


if __name__ == "__main__":
    unittest.main()
