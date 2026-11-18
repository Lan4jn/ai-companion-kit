import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SUPERVISOR = ROOT / 'scripts' / 'isolated_session_supervisor.py'

class CrashCleanupTest(unittest.TestCase):
    def test_close_does_not_signal_reused_pid(self):
        import importlib.util
        spec=importlib.util.spec_from_file_location('crash_supervisor', SUPERVISOR)
        mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        unrelated=subprocess.Popen(['/usr/bin/sleep','30'], start_new_session=True)
        class ReapedProcess:
            pid=unrelated.pid
            def wait(self): return 0
        session=mod.IsolatedSession(['/usr/bin/true'],uid=65534,gid=65534)
        session._process=ReapedProcess()
        try:
            session.close()
            self.assertIsNone(unrelated.poll(), 'stale PID killed unrelated process')
        finally:
            unrelated.terminate(); unrelated.wait()

    def test_sigkill_removes_detached_descendant(self):
        if os.geteuid() != 0 or subprocess.run(['unshare','--net','--pid','--fork','true'], stderr=subprocess.DEVNULL).returncode:
            self.skipTest('requires root, network and pid namespaces')
        with tempfile.TemporaryDirectory(dir='/run', prefix='crash-test-') as d:
            os.chmod(d, 0o777)
            marker = os.path.join(d, 'pids')
            worker = '''import os,subprocess,sys,time\np=subprocess.Popen(['/usr/bin/sleep','120'], start_new_session=True)\nopen(sys.argv[1], 'w').write(str(os.getpid())+' '+str(p.pid))\ntime.sleep(120)'''
            parent = '''import importlib.util,sys,time\ns=importlib.util.spec_from_file_location('s',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\nx=m.IsolatedSession(['/usr/bin/python3','-c',sys.argv[3],sys.argv[2]],uid=65534,gid=65534,ttl=90).start()\nprint(x.pid,flush=True); time.sleep(120)'''
            proc = subprocess.Popen([sys.executable, '-c', parent, str(SUPERVISOR), marker, worker], stdout=subprocess.PIPE, text=True)
            pids=[]
            try:
                leader = int(proc.stdout.readline())
                deadline=time.monotonic()+10
                while not os.path.exists(marker) and time.monotonic()<deadline: time.sleep(.05)
                self.assertTrue(os.path.exists(marker), 'worker did not start')
                # Marker PIDs are namespace-local when PID isolation is enabled;
                # identify the host descendants from procfs before killing.
                def descendants(root):
                    found=set(); pending=[root]
                    while pending:
                        p=pending.pop()
                        try:
                            for tid in os.listdir(f'/proc/{p}/task'):
                                for c in pathlib.Path(f'/proc/{p}/task/{tid}/children').read_text().split():
                                    c=int(c)
                                    if c not in found: found.add(c); pending.append(c)
                        except (FileNotFoundError, ProcessLookupError): pass
                    return found
                pids=list(descendants(proc.pid)); self.assertGreaterEqual(len(pids),2)
                os.kill(proc.pid,signal.SIGKILL); proc.wait(timeout=5)
                deadline=time.monotonic()+5
                def live(pid):
                    try: return pathlib.Path(f'/proc/{pid}/stat').read_text().split(') ')[1][0] != 'Z'
                    except FileNotFoundError: return False
                while any(map(live,pids)) and time.monotonic()<deadline: time.sleep(.05)
                self.assertFalse([p for p in pids if live(p)], 'descendants survived supervisor SIGKILL')
            finally:
                if proc.poll() is None: proc.kill(); proc.wait()
                for p in pids:
                    try: os.kill(p,signal.SIGKILL)
                    except ProcessLookupError: pass
                proc.stdout.close()

if __name__ == '__main__': unittest.main()
