#!/usr/bin/env python3
"""Concurrency and failure-closed tests for the synthetic UID ledger."""
import concurrent.futures
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ledger', Path(__file__).resolve().parents[1] / 'scripts/synthetic_uid_ledger.py')
ledger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ledger)


def claim(directory):
    return ledger.allocate_fixture_uid(directory, 62000, 62023)


@unittest.skipUnless(os.geteuid() == 0, 'requires root')
class LedgerTest(unittest.TestCase):
    def test_concurrent_claims_and_no_reuse(self):
        with tempfile.TemporaryDirectory(dir='/run') as d:
            with concurrent.futures.ProcessPoolExecutor(max_workers=12) as pool:
                uids = list(pool.map(claim, [d] * 24))
            self.assertEqual(sorted(uids), list(range(62000, 62024)))
            with self.assertRaises(RuntimeError):
                claim(d)
            with self.assertRaises(ValueError):
                ledger.allocate_fixture_uid(d, 62000, 62024)

    def test_rejects_unsafe_or_corrupt_ledger(self):
        with tempfile.TemporaryDirectory(dir='/run') as d:
            p = Path(d) / 'uid-ledger'
            p.symlink_to('/dev/null')
            with self.assertRaises(OSError): claim(d)
            p.unlink()
            p.write_text('62000:62023\n62001\n')
            p.chmod(0o600)
            with self.assertRaises(ValueError): claim(d)
            p.unlink()
            os.chmod(d, 0o755)
            with self.assertRaises(PermissionError): claim(d)

if __name__ == '__main__': unittest.main()
