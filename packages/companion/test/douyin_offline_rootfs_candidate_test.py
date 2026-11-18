import importlib.util
import pathlib
import socket
import os
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('rootfs_candidate', ROOT / 'scripts/douyin_offline_rootfs_candidate.py')

def load_candidate():
 if SPEC is None or SPEC.loader is None or SPEC.origin is None or not pathlib.Path(SPEC.origin).exists():
  raise AssertionError('offline rootfs candidate missing')
 module = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(module)
 return module

class OfflineRootfsCandidate(unittest.TestCase):
 def test_nonroot_denied(self):
  source = (ROOT / 'scripts/douyin_offline_rootfs_candidate.py').read_text()
  result = subprocess.run(['/usr/bin/setpriv','--reuid=61101','--regid=61101','--clear-groups','/usr/bin/python3','-c',
   source + '\nrun_synthetic_probe()'], capture_output=True, text=True, timeout=10)
  self.assertNotEqual(result.returncode, 0)
  self.assertIn('root required', result.stderr)

 def test_existing_identity_fails_closed(self):
  module=load_candidate()
  p=subprocess.Popen(['/usr/bin/setpriv','--reuid=61101','--regid=61101','--clear-groups','/usr/bin/sleep','30'])
  try:
   import time
   deadline=time.monotonic()+5
   while not module._active() and time.monotonic()<deadline: time.sleep(.01)
   self.assertTrue(module._active())
   with self.assertRaisesRegex(RuntimeError, 'already active'): module.run_synthetic_probe()
  finally:
   p.terminate(); p.wait(timeout=5)

 def test_boundary_and_lifecycle(self):
  module = load_candidate()
  self.assertTrue(callable(module.run_synthetic_probe))
  result = module.run_synthetic_probe()
  self.assertEqual(result['sentinel_hidden'], True)
  self.assertEqual(result['host_loopback_denied'], True)
  self.assertEqual(result['distinct_uid'], True)
  self.assertEqual(result['detached_reaped'], True)

if __name__ == '__main__': unittest.main()
