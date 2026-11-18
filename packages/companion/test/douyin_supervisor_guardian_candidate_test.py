import os
import pathlib
import select
import signal
import subprocess
import sys
import time
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import douyin_process_supervisor_candidate as candidate

class GuardianTest(unittest.TestCase):
    def test_unexpected_file_is_retained_not_recursively_deleted(self):
        with self.assertRaisesRegex(RuntimeError, 'retained'):
            with candidate.private_fixture_directory() as d:
                path = pathlib.Path(d)
                (path / 'unexpected').write_text('keep')
        try:
            self.assertEqual((path / 'unexpected').read_text(), 'keep')
        finally:
            (path / 'unexpected').unlink()
            path.rmdir()

    def test_symlink_is_unlinked_without_touching_target(self):
        import tempfile
        with tempfile.TemporaryDirectory() as target_dir:
            target = pathlib.Path(target_dir) / 'unrelated'
            target.write_text('safe')
            with candidate.private_fixture_directory() as d:
                (pathlib.Path(d) / 'sentinel').symlink_to(target)
            self.assertEqual(target.read_text(), 'safe')

    def test_supervisor_sigkill_reclaims_only_private_fixture_files(self):
        code = '''import sys,time,pathlib
sys.path.insert(0,sys.argv[1])
import douyin_process_supervisor_candidate as c
with c.private_fixture_directory() as d:
 pathlib.Path(d,"worker.py").write_text("x")
 pathlib.Path(d,"sentinel").write_text("x")
 print(d,flush=True)
 time.sleep(30)
'''
        p = subprocess.Popen([sys.executable, '-c', code, str(SCRIPTS)], stdout=subprocess.PIPE, text=True)
        try:
            path = p.stdout.readline().strip()
            self.assertTrue(path and pathlib.Path(path).is_dir())
            os.kill(p.pid, signal.SIGKILL)
            p.wait(timeout=3)
            deadline = time.monotonic() + 5
            while pathlib.Path(path).exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertFalse(pathlib.Path(path).exists())
        finally:
            if p.poll() is None: p.kill(); p.wait()
            p.stdout.close()

if __name__ == '__main__': unittest.main()
