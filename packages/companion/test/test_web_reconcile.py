import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'tools' / 'web_reconcile.py'
spec = importlib.util.spec_from_file_location('web_reconcile', MODULE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class ReconcileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.addCleanup(self.tmp.cleanup)
        self.f = Path(self.tmp.name) / 'goals.json'
        self.f.write_text(json.dumps({'version': 1, 'goals': {'g': {'id':'g','title':json.dumps({'kind':'web-deep-search','topic':'Hello, World', 'private':'SECRET_BODY'}),'target':1,'progress':0,'status':'active'}}, 'desires': {'d':{'id':'d','goalId':'g','status':'active'}}, 'events': {}}))
    def audit(self): return mod.audit(self.f, 'g', 'd', 'hello world')
    def resolve(self, v, outcome='completed'):
        return mod.resolve(self.f, 'g', 'd', 'hello world', v, outcome, 'operator-1', 'case-123')
    def test_audit_and_confirmed_atomic_transition(self):
        audit = self.audit()
        self.assertNotIn('SECRET_BODY', json.dumps(audit))
        self.resolve(audit['version'])
        s = json.loads(self.f.read_text())
        self.assertEqual(s['goals']['g']['status'], 'completed')
        self.assertEqual(s['desires']['d']['status'], 'completed')
        with self.assertRaises(mod.ReconcileError): self.resolve(audit['version'])
    def test_changed_store_wrong_topic_scope_and_identifier_fail_closed(self):
        v = self.audit()['version']
        with self.assertRaises(mod.ReconcileError): mod.audit(self.f, 'g', 'd', 'different')
        with self.assertRaises(mod.ReconcileError): mod.audit(self.f, 'g', 'other', 'hello world')
        self.f.write_text(self.f.read_text() + ' ')
        with self.assertRaises(mod.ReconcileError): self.resolve(v)
        self.assertEqual(json.loads(self.f.read_text())['goals']['g']['status'], 'active')
    def test_store_lock_is_interoperable_with_external_flock(self):
        v = self.audit()['version']
        proc = subprocess.Popen(['flock', '-x', str(self.f)+'.lock', sys.executable, '-c', "import sys,time; print('locked',flush=True); time.sleep(10)"], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(proc.stdout.readline().strip(), 'locked')
            with self.assertRaises(mod.ReconcileError): self.resolve(v)
        finally:
            proc.terminate(); proc.wait(); proc.stdout.close()
        self.assertEqual(json.loads(self.f.read_text())['goals']['g']['status'], 'active')
    def test_write_failure_and_ambiguous_postrename_failure(self):
        v = self.audit()['version']
        with patch.object(mod.os, 'replace', side_effect=OSError('failure')):
            with self.assertRaises(OSError): self.resolve(v)
        self.assertEqual(self.audit()['version'], v)
        original = mod.os.fsync
        count = 0
        def fsync(fd):
            nonlocal count
            count += 1
            if count == 2: raise OSError('uncertain')
            return original(fd)
        with patch.object(mod.os, 'fsync', side_effect=fsync):
            with self.assertRaises(OSError): self.resolve(v, 'terminated')
        self.assertEqual(json.loads(self.f.read_text())['goals']['g']['status'], 'failed')
        with self.assertRaises(mod.ReconcileError): self.resolve(v)
    def test_process_crashes_before_and_after_rename(self):
        v = self.audit()['version']
        script = """import importlib.util,os,sys
s=importlib.util.spec_from_file_location('r',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
original=m.os.replace
def crash(a,b):
 if sys.argv[4]=='after': original(a,b)
 os._exit(9)
m.os.replace=crash
m.resolve(sys.argv[2],'g','d','hello world',sys.argv[3],'completed','operator-1','case-123')
"""
        args = [sys.executable, '-c', script, str(MODULE), str(self.f), v]
        self.assertEqual(subprocess.run(args + ['before']).returncode, 9)
        self.assertEqual(self.audit()['version'], v)
        self.assertEqual(subprocess.run(args + ['after']).returncode, 9)
        self.assertEqual(json.loads(self.f.read_text())['goals']['g']['status'], 'completed')
        with self.assertRaises(mod.ReconcileError): self.resolve(v)
    def test_cli_rejects_store_outside_workspace_without_leaking_body(self):
        p = subprocess.run([sys.executable, str(MODULE), 'audit', '--store', '/dev/null', '--goal', 'g', '--desire', 'd', '--topic', 'hello world'], capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn('SECRET_BODY', p.stdout + p.stderr)
    def test_competing_processes_cannot_both_resolve(self):
        v = self.audit()['version']
        script = "import importlib.util,sys; s=importlib.util.spec_from_file_location('r',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.resolve(sys.argv[2],'g','d','hello world',sys.argv[3],'completed','operator-1','case-123')"
        ps = [subprocess.Popen([sys.executable, '-c', script, str(MODULE), str(self.f), v], stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(2)]
        results = [p.communicate() or p.returncode for p in ps]
        self.assertEqual(sorted(p.returncode for p in ps), [0, 1])
        self.assertEqual(len(json.loads(self.f.read_text())['events']), 1)
