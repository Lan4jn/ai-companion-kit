import importlib.util
import pathlib
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'douyin_process_supervisor_candidate.py'
spec = importlib.util.spec_from_file_location('supervisor_identity', PATH)
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)

class IdentityBoundaryTest(unittest.TestCase):
    def test_fixed_uid_cannot_start_without_exclusive_identity(self):
        with self.assertRaisesRegex(RuntimeError, 'exclusive identity'):
            candidate.run_fixture(ttl=.1)

if __name__ == '__main__': unittest.main()
