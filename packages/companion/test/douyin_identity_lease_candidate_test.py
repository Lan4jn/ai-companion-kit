import importlib.util
import multiprocessing
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'douyin_identity_lease_candidate.py'
def load():
    spec = importlib.util.spec_from_file_location('lease_candidate', PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def attempt(directory, queue):
    candidate = load()
    with patch.object(candidate, '_validate_identity', return_value=None):
        try: queue.put(('ok', candidate.burn_reserved_identity(directory, [(61101, 61101, 'dyfixture61101')])))
        except Exception as exc: queue.put(('error', str(exc)))

class LeaseTest(unittest.TestCase):
    def test_concurrent_single_identity_is_burned_once(self):
        with tempfile.TemporaryDirectory() as directory:
            ctx = multiprocessing.get_context('fork')
            queue = ctx.Queue()
            children = [ctx.Process(target=attempt, args=(directory, queue)) for _ in range(4)]
            for p in children: p.start()
            for p in children: p.join(5); self.assertEqual(p.exitcode, 0)
            results = [queue.get(timeout=2) for _ in children]
            self.assertEqual(sum(x[0] == 'ok' for x in results), 1)
            self.assertEqual(sum(x[0] == 'error' for x in results), 3)
            self.assertTrue(pathlib.Path(directory, 'uid-61101').is_file())

    def test_gid_cannot_be_reused_under_a_different_uid(self):
        candidate = load()
        with tempfile.TemporaryDirectory() as directory, patch.object(candidate, '_validate_identity', return_value=None):
            candidate.burn_reserved_identity(directory, [(61101, 61101, 'dyfixture61101')])
            with self.assertRaisesRegex(RuntimeError, 'exhausted'):
                candidate.burn_reserved_identity(directory, [(61102, 61101, 'dyfixture61102')])

    def test_failed_validation_burns_identity(self):
        candidate = load()
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(candidate, '_validate_identity', side_effect=RuntimeError('conflict')):
                with self.assertRaisesRegex(RuntimeError, 'conflict'):
                    candidate.burn_reserved_identity(directory, [(61101, 61101, 'dyfixture61101')])
            with patch.object(candidate, '_validate_identity', return_value=None):
                with self.assertRaisesRegex(RuntimeError, 'exhausted'):
                    candidate.burn_reserved_identity(directory, [(61101, 61101, 'dyfixture61101')])

    def test_untrusted_or_symlinked_ledger_rejected(self):
        candidate = load()
        with tempfile.TemporaryDirectory() as directory:
            real = pathlib.Path(directory, 'real')
            real.mkdir(mode=0o700)
            link = pathlib.Path(directory, 'link')
            link.symlink_to(real, target_is_directory=True)
            with self.assertRaises(OSError):
                candidate.burn_reserved_identity(str(link), [(61101, 61101, 'dyfixture61101')])
            real.chmod(0o777)
            with self.assertRaisesRegex(RuntimeError, 'untrusted'):
                candidate.burn_reserved_identity(str(real), [(61101, 61101, 'dyfixture61101')])

if __name__ == '__main__': unittest.main()
