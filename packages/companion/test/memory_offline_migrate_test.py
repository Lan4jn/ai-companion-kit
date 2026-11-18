import json, os, pty, re, select, signal, sqlite3, subprocess, tempfile, time, unittest, hashlib, shutil
from pathlib import Path

SCRIPT=str(Path(__file__).resolve().parents[1]/'scripts/memory-offline-migrate.py')
def js(x): return json.dumps(x,ensure_ascii=False,separators=(',',':'))
class Offline(unittest.TestCase):
 def setUp(self):
  self.d=Path(tempfile.mkdtemp(prefix='migration-fixture-',dir=os.environ['TMPDIR'])); self.scope={'tenant':'test','platform':'qq','type':'private','session':'private:1','user':'1'}; self.source='qq-private-message'; self.event='onebot-message:42'; self.created=time.time()-1
  self.stem=hashlib.sha256(js([self.scope,self.source]).encode()).hexdigest(); self.src=self.d/(self.stem+'.sqlite3'); self.dst=self.d/('sqlite-fts-v1-'+self.stem+'.sqlite3')
  self.src.touch(mode=0o600); db=sqlite3.connect(self.src); db.executescript('CREATE TABLE adapter_policy(id INTEGER PRIMARY KEY,revoked INTEGER); CREATE TABLE adapter_retention(id INTEGER PRIMARY KEY,retention_ms INTEGER); CREATE TABLE adapter_forget_tombstones(evidence_hash TEXT PRIMARY KEY); CREATE TABLE memories(text TEXT,source TEXT,meta TEXT,created_at REAL,status TEXT,visibility TEXT); INSERT INTO adapter_retention VALUES(1,86400000);'); db.execute('INSERT INTO memories VALUES(?,?,?,?,?,?)',('fixture',self.source,js({'scope':self.scope,'evidence':self.event,'adapter_version':1}),self.created,'active','private')); db.commit(); db.close()
  self.proof=self.d/'proof.json'; self.writeproof()
 def writeproof(self,text='fixture'):
  self.proof.write_text(js({'scope':self.scope,'source':self.source,'event':self.event,'text':text,'created_at':self.created,'provenance':'operator reviewed synthetic export'})); self.proof.chmod(0o600)
 def tearDown(self): shutil.rmtree(self.d)
 def runcli(self,user='1',change=None,script=SCRIPT):
  master,slave=pty.openpty(); p=subprocess.Popen(['/usr/bin/python3',script,str(self.d),str(self.proof),'test',user,self.event,'--retention-ms','86400000'],stdin=slave,stdout=slave,stderr=slave,close_fds=True); os.close(slave); out=b''; end=time.time()+10; sent=False
  while time.time()<end:
   if select.select([master],[],[],.1)[0]:
    try: out+=os.read(master,65536)
    except OSError: break
    m=re.search(rb'CONFIRM ([a-f0-9]{32})',out)
    if m and not sent:
     if change: change()
     os.write(master,b'CONFIRM '+m.group(1)+b'\n'); sent=True
   if p.poll() is not None: break
  p.wait(timeout=5); os.close(master); return p.returncode,out.decode(errors='replace')
 def test_visible_open_source_blocks_migration(self):
  fd=os.open(self.src,os.O_RDONLY)
  try:
   status,out=self.runcli(); self.assertNotEqual(status,0,out); self.assertIn('visible',out); self.assertFalse(self.dst.exists())
  finally: os.close(fd)
 def test_source_sqlite_writer_blocks_migration(self):
  db=sqlite3.connect(self.src,timeout=0); db.execute('BEGIN IMMEDIATE')
  try:
   status,out=self.runcli(); self.assertNotEqual(status,0,out)
   if self.dst.exists() and self.dst.stat().st_size:
    target=sqlite3.connect(self.dst); self.assertFalse(target.execute("SELECT 1 FROM sqlite_master WHERE name='local_entries'").fetchone()); target.close()
  finally: db.rollback(); db.close()
 def test_positive_and_duplicate(self):
  status,out=self.runcli(); self.assertEqual(status,0,out); self.assertIn('inserted',out)
  db=sqlite3.connect(self.dst); self.assertEqual(db.execute('SELECT evidence,text,created FROM local_entries').fetchall(),[(self.event,'fixture',self.created)]); self.assertEqual(db.execute('SELECT retention FROM local_identity').fetchone()[0],86400000); db.close()
  db=sqlite3.connect(self.d/'offline-migration-audit.sqlite3'); self.assertEqual(db.execute('SELECT status FROM attempts').fetchone()[0],'inserted'); self.assertNotIn('fixture',self.d.joinpath('offline-migration-audit.sqlite3').read_bytes().decode(errors='ignore')); db.close()
  status,out=self.runcli(); self.assertNotEqual(status,0); self.assertIn('already attempted',out)
 def test_bad_proof_and_scope(self):
  self.writeproof('forged'); status,out=self.runcli(); self.assertNotEqual(status,0); self.assertIn('disagree',out); self.assertFalse(self.dst.exists())
  self.writeproof(); status,out=self.runcli(user='2'); self.assertNotEqual(status,0); self.assertFalse(self.dst.exists())
 def test_source_revoked_during_confirmation_blocks_import(self):
  marker=Path(str(self.src)+'.revoked')
  status,out=self.runcli(change=lambda:marker.touch(mode=0o600))
  self.assertNotEqual(status,0,out); self.assertIn('sidecar or revocation present',out)
  self.assertFalse(self.dst.exists())
  db=sqlite3.connect(self.d/'offline-migration-audit.sqlite3'); self.assertEqual(db.execute('SELECT COUNT(*) FROM attempts').fetchone()[0],0); db.close()
 def test_sidecars_and_ame_created_during_confirmation_block_import(self):
  for path in (Path(str(self.src)+'-wal'),Path(str(self.dst)+'-journal'),self.d/('ame-v1-'+self.stem+'.sqlite3')):
   with self.subTest(path=path.name):
    status,out=self.runcli(change=lambda:path.touch(mode=0o600))
    self.assertNotEqual(status,0,out); self.assertFalse(self.dst.exists())
    path.unlink()
 def test_changed_after_confirmation(self):
  status,out=self.runcli(change=lambda:self.writeproof('changed')); self.assertNotEqual(status,0); self.assertIn('files changed',out); self.assertFalse(self.dst.exists())
 def test_forget_and_audit_failure_fail_closed(self):
  db=sqlite3.connect(self.src); db.execute('INSERT INTO adapter_forget_tombstones VALUES(?)',(hashlib.sha256(self.event.encode()).hexdigest(),)); db.commit(); db.close()
  status,out=self.runcli(); self.assertNotEqual(status,0); self.assertIn('forgotten',out); self.assertFalse(self.dst.exists())
  db=sqlite3.connect(self.src); db.execute('DELETE FROM adapter_forget_tombstones'); db.commit(); db.close()
  audit=self.d/'offline-migration-audit.sqlite3'; audit.mkdir()
  status,out=self.runcli(); self.assertNotEqual(status,0); self.assertFalse(self.dst.exists())
 def test_exact_metadata_scope_cannot_cross_tenant_or_user(self):
  db=sqlite3.connect(self.src)
  wrong={**self.scope,'tenant':'other'}
  db.execute('UPDATE memories SET meta=?',(js({'scope':wrong,'evidence':self.event,'adapter_version':1}),)); db.commit(); db.close()
  status,out=self.runcli(); self.assertNotEqual(status,0); self.assertIn('disagree',out); self.assertFalse(self.dst.exists())
 def test_destination_tombstone_blocks_fresh_authorization(self):
  # Construct an existing, identity-matched target with a tombstone only.
  self.dst.touch(mode=0o600); db=sqlite3.connect(self.dst)
  db.executescript('CREATE TABLE local_identity(identity TEXT, retention INTEGER, revoked INTEGER); CREATE TABLE local_tombstones(digest TEXT PRIMARY KEY); CREATE TABLE local_entries(id TEXT, evidence TEXT, text TEXT, created REAL);')
  db.execute('INSERT INTO local_identity VALUES(?,?,0)',(json.dumps([self.scope,self.source],ensure_ascii=False,sort_keys=True,separators=(',',':')),86400000))
  db.execute('INSERT INTO local_tombstones VALUES(?)',(hashlib.sha256(self.event.encode()).hexdigest(),)); db.commit(); db.close()
  status,out=self.runcli(); self.assertNotEqual(status,0); self.assertIn('forgotten',out)
  db=sqlite3.connect(self.dst); self.assertEqual(db.execute('SELECT * FROM local_entries').fetchall(),[]); db.close()
  self.assertFalse((self.d/'offline-migration-audit.sqlite3').exists())
 def concurrent_forget(self, revoke):
  # Instrument only a disposable worker copy; authorization comes from the real CLI PTY flow.
  root=Path(tempfile.mkdtemp(prefix='migration-race-',dir=os.environ['TMPDIR'])); self.addCleanup(shutil.rmtree,root)
  (root/'scripts').mkdir(); (root/'src').mkdir()
  for name in ('memory-offline-migrate.py','memory-offline-preflight.py'):
   shutil.copy(Path(SCRIPT).parent/name,root/'scripts'/name)
  worker=(Path(SCRIPT).parents[1]/'src/memory-sqlite-fts-worker.py').read_text()
  marker=("        db = sqlite3.connect(path, timeout=10)" if revoke=='replace' else "        elif op == 'migrateLegacyEvidence':\n            rec=r['record']; ev=rec['evidence']\n            db.execute('BEGIN IMMEDIATE')")
  self.assertEqual(worker.count(marker),1)
  worker=worker.replace(marker, ("        os.kill(os.getpid(), 19)\n"+marker) if revoke=='replace' else marker.replace("            db.execute('BEGIN IMMEDIATE')","            os.kill(os.getpid(), 19)\n            db.execute('BEGIN IMMEDIATE')"))
  (root/'src/memory-sqlite-fts-worker.py').write_text(worker)
  self.dst.touch(mode=0o600); db=sqlite3.connect(self.dst)
  db.executescript('CREATE TABLE local_identity(identity TEXT, retention INTEGER, revoked INTEGER); CREATE TABLE local_tombstones(digest TEXT PRIMARY KEY); CREATE TABLE local_entries(id TEXT, evidence TEXT, text TEXT, created REAL);')
  db.execute('INSERT INTO local_identity VALUES(?,?,0)',(json.dumps([self.scope,self.source],ensure_ascii=False,sort_keys=True,separators=(',',':')),86400000)); db.commit(); db.close()
  master,slave=pty.openpty(); proc=subprocess.Popen(['/usr/bin/python3',str(root/'scripts/memory-offline-migrate.py'),str(self.d),str(self.proof),'test','1',self.event,'--retention-ms','86400000'],stdin=slave,stdout=slave,stderr=slave,close_fds=True); os.close(slave)
  stopped=None; out=b''; sent=False
  try:
   deadline=time.monotonic()+10
   while time.monotonic()<deadline and proc.poll() is None:
    if select.select([master],[],[],.02)[0]:
     try: out+=os.read(master,65536)
     except OSError: pass
     m=re.search(rb'CONFIRM ([a-f0-9]{32})',out)
     if m and not sent: os.write(master,b'CONFIRM '+m.group(1)+b'\n'); sent=True
    try: children=Path(f'/proc/{proc.pid}/task/{proc.pid}/children').read_text().split()
    except FileNotFoundError: children=[]
    for child in children:
     try:
      if Path(f'/proc/{child}/status').read_text().split('State:')[1].strip().startswith('T'): stopped=int(child); break
     except FileNotFoundError: pass
    if stopped: break
   self.assertIsNotNone(stopped,out.decode(errors='replace'))
   audit=sqlite3.connect(self.d/'offline-migration-audit.sqlite3'); self.assertEqual(audit.execute('SELECT status FROM attempts').fetchone()[0],'consumed'); audit.close()
   if revoke=='replace':
    replacement=self.d/'replacement'; shutil.copyfile(self.dst,replacement); replacement.chmod(0o600); os.replace(replacement,self.dst)
    os.kill(stopped,signal.SIGCONT); proc.wait(timeout=10)
    self.assertNotEqual(proc.returncode,0,'replacement must fail closed')
    db=sqlite3.connect(self.dst); self.assertEqual(db.execute('SELECT * FROM local_entries').fetchall(),[]); db.close()
    return
   db=sqlite3.connect(self.dst); db.execute('BEGIN IMMEDIATE')
   if revoke: db.execute('UPDATE local_identity SET revoked=1')
   else: db.execute('INSERT INTO local_tombstones VALUES(?)',(hashlib.sha256(self.event.encode()).hexdigest(),))
   os.kill(stopped,signal.SIGCONT); time.sleep(.2)
   self.assertIsNone(proc.poll(),'migration must wait on destination SQLite transaction')
   db.commit(); db.close(); proc.wait(timeout=10)
   while select.select([master],[],[],0)[0]:
    try: out+=os.read(master,65536)
    except OSError: break
   output=out.decode(errors='replace')
   if revoke: self.assertNotEqual(proc.returncode,0,output)
   else: self.assertEqual(proc.returncode,0,output); self.assertIn('forgotten',output)
   db=sqlite3.connect(self.dst); self.assertEqual(db.execute('SELECT COUNT(*) FROM local_entries').fetchone()[0],0)
   self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='local_history_reservations'").fetchone()); db.close()
  finally:
   if stopped:
    try: os.kill(stopped,signal.SIGCONT)
    except ProcessLookupError: pass
   if proc.poll() is None: proc.kill(); proc.wait()
   os.close(master)
 def test_worker_denies_missing_and_tampered_authorization(self):
  for mutation in ('missing','tampered'):
   with self.subTest(mutation=mutation):
    if mutation!='missing': self.tearDown(); self.setUp()
    root=Path(tempfile.mkdtemp(prefix='migration-auth-',dir=os.environ['TMPDIR'])); self.addCleanup(shutil.rmtree,root); (root/'scripts').mkdir(); (root/'src').mkdir()
    script=Path(SCRIPT).read_text(); marker="            request['authorization']=token"
    self.assertEqual(script.count(marker),1)
    script=script.replace(marker,"            request['authorization']="+('None' if mutation=='missing' else "'0'*32"))
    (root/'scripts/memory-offline-migrate.py').write_text(script)
    shutil.copy(Path(SCRIPT).parent/'memory-offline-preflight.py',root/'scripts/memory-offline-preflight.py')
    shutil.copy(Path(SCRIPT).parents[1]/'src/memory-sqlite-fts-worker.py',root/'src/memory-sqlite-fts-worker.py')
    code,out=self.runcli(script=str(root/'scripts/memory-offline-migrate.py')); self.assertNotEqual(code,0,out)
    audit=sqlite3.connect(self.d/'offline-migration-audit.sqlite3'); self.assertEqual(audit.execute('SELECT status FROM attempts').fetchall(),[('attempt',)]); audit.close()
    self.assertTrue(self.dst.exists()); self.assertEqual(self.dst.stat().st_size,0)
    code,out=self.runcli(); self.assertNotEqual(code,0,out); self.assertIn('no such table: local_identity',out)
    audit=sqlite3.connect(self.d/'offline-migration-audit.sqlite3'); self.assertEqual(audit.execute('SELECT status FROM attempts').fetchall(),[('attempt',)]); audit.close()
 def test_target_replaced_after_check_before_open(self): self.concurrent_forget('replace')
 def test_concurrent_uncoordinated_scope_revocation_blocks_worker(self): self.concurrent_forget(True)
 def test_concurrent_uncoordinated_event_tombstone_blocks_worker(self): self.concurrent_forget(False)
 def test_prior_unknown_never_replayed(self):
  status,out=self.runcli(); self.assertEqual(status,0,out)
  db=sqlite3.connect(self.d/'offline-migration-audit.sqlite3'); db.execute("UPDATE attempts SET status='attempt'"); db.commit(); db.close()
  status,out=self.runcli(); self.assertNotEqual(status,0); self.assertIn('already attempted',out)
if __name__=='__main__': unittest.main()
