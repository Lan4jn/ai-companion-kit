import importlib.util
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('synthetic_handoff', Path(__file__).resolve().parents[1] / 'scripts' / 'synthetic_login_handoff.py')
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class HandoffTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = 10
        self.h = m.SyntheticHandoff(self.root, clock=lambda: self.now)

    def complete(self, token, **kwargs):
        values = dict(owner_approved=True, platform_verified=True, candidate=m.FIXTURE)
        values.update(kwargs)
        self.h.complete(token, **values)

    def test_success_one_use_private_atomic_target(self):
        target = self.root / 'synthetic-session.fixture'
        target.write_bytes(b'old')
        token = self.h.start()
        self.complete(token)
        self.assertEqual(target.read_bytes(), m.FIXTURE)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(m.Denied): self.complete(token)
        self.assertEqual(list(self.root.iterdir()), [target])

    def test_denials_consume_valid_session(self):
        for changes in ({'owner_approved': False}, {'platform_verified': False}, {'candidate': b'not-a-fixture'}):
            with self.subTest(changes=changes):
                self.h = m.SyntheticHandoff(self.root, clock=lambda: self.now)
                token = self.h.start()
                with self.assertRaises(m.Denied): self.complete(token, **changes)
                with self.assertRaises(m.Denied): self.complete(token)
                self.assertEqual(list(self.root.iterdir()), [])

    def test_bad_token_does_not_consume_and_expiry_does(self):
        token = self.h.start()
        with self.assertRaises(m.Denied): self.complete('wrong')
        self.now = 40
        with self.assertRaises(m.Denied): self.complete(token)
        with self.assertRaises(m.Denied): self.complete(token)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_explicit_close(self):
        token = self.h.start()
        self.h.close()
        with self.assertRaises(m.Denied): self.complete(token)

    def test_race_single_winner(self):
        token = self.h.start()
        results = []
        def worker():
            try: self.complete(token); results.append('ok')
            except m.Denied: results.append('denied')
        threads = [threading.Thread(target=worker) for _ in range(12)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(results.count('ok'), 1)
        self.assertEqual(results.count('denied'), 11)

    def test_unsafe_directory_and_symlink_target(self):
        os.chmod(self.root, 0o755)
        with self.assertRaises(m.Denied): m.SyntheticHandoff(self.root)
        os.chmod(self.root, 0o700)
        outside = self.root.parent / (self.root.name + '-outside')
        outside.write_bytes(b'unchanged')
        self.addCleanup(outside.unlink, missing_ok=True)
        (self.root / 'synthetic-session.fixture').symlink_to(outside)
        self.complete(self.h.start())
        self.assertEqual(outside.read_bytes(), b'unchanged')

    def test_write_failure_does_not_replace_or_leave_temp(self):
        target = self.root / 'synthetic-session.fixture'
        target.write_bytes(b'old')
        token = self.h.start()
        with mock.patch.object(m.os, 'replace', side_effect=OSError('synthetic')):
            with self.assertRaises(OSError): self.complete(token)
        self.assertEqual(target.read_bytes(), b'old')
        self.assertEqual(list(self.root.iterdir()), [target])
        with self.assertRaises(m.Denied): self.complete(token)

if __name__ == '__main__': unittest.main()
