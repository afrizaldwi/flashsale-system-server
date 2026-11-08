"""Mock-only regression tests; never issue HTTP requests or Docker commands."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[2] / "scripts" / "test-transactional-checkout.py"
spec = importlib.util.spec_from_file_location("transactional_checkout", source)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class SafetyTests(unittest.TestCase):
    def test_default_retains_data_and_cleanup_is_explicit(self):
        for flags, expected in [([], False), (["--no-cleanup"], False), (["--cleanup"], True)]:
            with patch.object(sys, "argv", ["test"] + flags):
                self.assertEqual(mod.parse_args().cleanup, expected)

    def test_transport_and_all_5xx_are_ambiguous(self):
        for status in [0, 500, 502, 503, 504, 599]:
            self.assertTrue(mod.is_ambiguous_response({"status": status}))
        for status in [200, 201, 409]:
            self.assertFalse(mod.is_ambiguous_response({"status": status}))

    def test_shared_lock_exclusive_and_replacement_owned_by_other_is_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            with mod.P3OperationLease(temp) as lease:
                owner = json.loads(lease.path.read_text())
                self.assertEqual(owner["pid"], os.getpid())
                self.assertTrue(owner["token"])
                with self.assertRaises(FileExistsError):
                    with mod.P3OperationLease(temp):
                        self.fail("Lock overlap")
                replacement = {"pid": os.getpid(), "token": "another-owner"}
                lease.path.write_text(json.dumps(replacement))
                with self.assertRaises(RuntimeError):
                    lease.check()
            self.assertEqual(json.loads(lease.path.read_text()), replacement)

    def test_recovery_manifest_blocks_transactions_and_cleanup(self):
        for content in ["{", json.dumps({"project": "flashsale-p3", "database": "flashsale_p3", "phase": "recovering"})]:
            with tempfile.TemporaryDirectory() as temp:
                Path(temp, "recovery.json").write_text(content)
                with self.assertRaises((ValueError, RuntimeError)):
                    with mod.P3OperationLease(temp):
                        self.fail("Incomplete recovery accepted")
                self.assertFalse(Path(temp, "operation.lock").exists())

    def test_foreign_node_style_operation_lock_is_not_stolen(self):
        with tempfile.TemporaryDirectory() as temp:
            lock = Path(temp, "operation.lock")
            content = json.dumps({"pid": os.getpid(), "token": "node-owner"})
            lock.write_text(content)
            with self.assertRaises(FileExistsError):
                with mod.P3OperationLease(temp):
                    self.fail("Acquired another owner's lock")
            self.assertEqual(lock.read_text(), content)

    def test_cleanup_checks_lease_before_sql(self):
        class Denied:
            def check(self):
                raise RuntimeError("ownership changed")
        with patch.object(mod, "query_p3_db") as query:
            with self.assertRaises(RuntimeError):
                mod.exact_atomic_cleanup("p3-tx-run", 1, "mock", lease=Denied())
            query.assert_not_called()

    def test_5xx_or_future_exception_prevents_cleanup_even_when_opted_in(self):
        from argparse import Namespace
        args = Namespace(url=mod.DEFAULT_URL, concurrency=1, product_id=1, cleanup=True)
        verified = {"consistent": True, "primary": {"database": "flashsale_p3", "standby": False, "foreign_orders": 0},
                    "replica": {"database": "flashsale_p3", "standby": True}}
        stats = {"total_orders": 0, "products": [{"id": 1, "name": "mock", "stock": 100}]}
        for status in [0, 500, 502, 503, 504, "exception"]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temp:
                def http(url, **kwargs):
                    if url.endswith("/health"):
                        return {"status": 200, "body": {"database": "flashsale_p3", "in_recovery": False}}
                    if url.endswith("/stats"):
                        return {"status": 200, "body": stats}
                    if status == "exception":
                        raise RuntimeError("failed future after request submitted")
                    return {"status": status, "body": {"error": "DB_UNAVAILABLE"}}
                with mod.P3OperationLease(temp) as lease, patch.object(mod, "http_request", side_effect=http), \
                     patch.object(mod, "resolve_p3_writer", return_value="mock"), \
                     patch.object(mod, "run_p3_verify", return_value=(True, None, verified)), \
                     patch.object(mod, "query_p3_db", return_value=(True, "0", "")), \
                     patch.object(mod, "exact_atomic_cleanup") as cleanup, contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as exited:
                        mod.run_test(args, lease)
                    self.assertEqual(exited.exception.code, 1)
                    cleanup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
