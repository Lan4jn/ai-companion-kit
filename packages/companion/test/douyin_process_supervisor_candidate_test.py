import importlib.util
import pathlib
import os
import subprocess
import sys
import time
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'douyin_process_supervisor_candidate.py'

@unittest.skip('fixed UID is no longer launchable without a trusted exclusive allocator')
class BoundedSupervisorTest(unittest.TestCase):
    def test_stalled_startup_is_killed_and_reaped(self):
        self.assertTrue(PATH.exists(), 'independent supervisor candidate missing')
        spec = importlib.util.spec_from_file_location('candidate', PATH)
        candidate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(candidate)
        start = time.monotonic()
        result = candidate.run_fixture(ttl=0.4, startup_delay=10)
        self.assertEqual(result['reason'], 'expired')
        self.assertTrue(result['reaped'])
        self.assertLess(time.monotonic() - start, 3)

    def test_offline_worker_and_detached_child_are_reaped(self):
        result = subprocess.run(['/usr/bin/python3', str(PATH)], capture_output=True, text=True, timeout=6, check=True)
        import json
        audit = json.loads(result.stdout)
        self.assertEqual(audit, {'reason':'expired', 'ready':True, 'reaped':True, 'sentinel_intact':True, 'network_control':True})
        # No process running as the fixed fixture UID may remain, including a
        # detached process that escaped the launcher's process group.
        deadline = time.monotonic() + 2
        while True:
            active = []
            for p in pathlib.Path('/proc').iterdir():
                if p.name.isdigit():
                    try:
                        if p.stat().st_uid == 61101 and (p / 'stat').read_text().split(') ',1)[1][0] != 'Z':
                            active.append(p.name)
                    except FileNotFoundError:
                        pass
            if not active or time.monotonic() >= deadline: break
            time.sleep(.05)
        self.assertFalse(active, 'fixture descendants survived')

if __name__ == '__main__': unittest.main()
