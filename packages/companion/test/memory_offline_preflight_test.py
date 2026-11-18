import json, os, sqlite3, subprocess, tempfile, time, unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SCRIPT=ROOT/'scripts/memory-offline-migrate.py'
DIAG=ROOT/'scripts/memory-offline-preflight.py'

class Preflight(unittest.TestCase):
 def test_migration_is_refused_without_writing(self):
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
   p=subprocess.run(['/usr/bin/python3',str(SCRIPT),d,str(Path(d)/'proof'),'test','1','onebot-message:42'],capture_output=True,text=True)
   self.assertNotEqual(p.returncode,0)
   self.assertIn('terminal required',p.stderr)
   self.assertEqual(list(Path(d).iterdir()),[])
 def test_reports_flock_and_multiple_db_processes(self):
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
   paths=[Path(d)/n for n in ('source.sqlite3','target.sqlite3','.forget-lock-test')]
   for path in paths: path.touch(mode=0o600)
   code='import fcntl,sqlite3,sys,time; a=sqlite3.connect(sys.argv[1]); b=sqlite3.connect(sys.argv[2]); a.execute("BEGIN IMMEDIATE"); b.execute("BEGIN IMMEDIATE"); f=open(sys.argv[3],"r+"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(30)'
   p=subprocess.Popen(['/usr/bin/python3','-c',code,*map(str,paths)],stdout=subprocess.PIPE,text=True)
   try:
    self.assertEqual(p.stdout.readline().strip(),'ready')
    data=json.loads(subprocess.check_output(['/usr/bin/python3',str(DIAG),d],text=True))
    self.assertTrue(set(path.name for path in paths).issubset({x['entry'] for x in data['open_files'] if x['pid']==p.pid}))
    self.assertTrue(set(path.name for path in paths).issubset({x['entry'] for x in data['sqlite_locks']}))
    self.assertFalse(data['authorizes_migration'])
   finally:
    p.terminate(); p.wait(); p.stdout.close()
 def test_reports_external_open_database_and_never_authorizes(self):
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
   db=Path(d)/'sample.sqlite3'; sqlite3.connect(db).close()
   p=subprocess.Popen(['/usr/bin/python3','-c','import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1]); c.execute("BEGIN IMMEDIATE"); print("ready",flush=True); time.sleep(30)',str(db)],stdout=subprocess.PIPE,text=True)
   try:
    self.assertEqual(p.stdout.readline().strip(),'ready')
    result=subprocess.run(['/usr/bin/python3',str(DIAG),d],capture_output=True,text=True,check=True)
    data=json.loads(result.stdout)
    self.assertFalse(data['authorizes_migration'])
    self.assertIn(p.pid,[entry['pid'] for entry in data['open_files']])
    self.assertTrue(data['sqlite_locks'])
   finally:
    p.terminate(); p.wait(); p.stdout.close()
