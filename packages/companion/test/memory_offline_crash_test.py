import os, pty, re, select, signal, shutil, sqlite3, subprocess, sys, tempfile, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_offline_migrate_test as fixture
SCRIPT=fixture.SCRIPT

class CrashRecovery(fixture.Offline):
 def crash_at(self, stage):
  # A disposable copy uses stop points; actual logic and SQLite worker are unchanged.
  root=Path(tempfile.mkdtemp(prefix='migration-instrumented-',dir=os.environ['TMPDIR'])); self.addCleanup(shutil.rmtree,root); (root/'scripts').mkdir(); (root/'src').mkdir()
  script=Path(SCRIPT).read_text(); worker=(Path(SCRIPT).parents[1]/'src/memory-sqlite-fts-worker.py').read_text()
  stop="os.kill(os.getpid(), 19)"
  commit_line="        if not readonly: db.commit()" if "        if not readonly: db.commit()" in worker else "        if op != 'privateHistory': db.commit()"
  replacements = {'before_reservation':"            ledger.execute('BEGIN IMMEDIATE')", 'after_reservation':"            if time.time()>expires: raise ValueError('authorization expired after reservation')", 'worker_before_commit':commit_line, 'worker_after_commit':"    print(json.dumps(result,ensure_ascii=False))"}
  target = worker if stage.startswith('worker_') else script
  self.assertEqual(target.count(replacements[stage]),1,'test stop point must be present exactly once')
  if stage=='before_reservation': script=script.replace("            ledger.execute('BEGIN IMMEDIATE')", "            "+stop+"\n            ledger.execute('BEGIN IMMEDIATE')")
  if stage=='after_reservation': script=script.replace("            if time.time()>expires: raise ValueError('authorization expired after reservation')", "            "+stop+"\n            if time.time()>expires: raise ValueError('authorization expired after reservation')")
  if stage=='worker_before_commit': worker=worker.replace(commit_line, "        if op == 'migrateLegacyEvidence': "+stop+"\n"+commit_line)
  if stage=='worker_after_commit': worker=worker.replace("    print(json.dumps(result,ensure_ascii=False))", "    if op == 'migrateLegacyEvidence': "+stop+"\n    print(json.dumps(result,ensure_ascii=False))")
  (root/'scripts/memory-offline-migrate.py').write_text(script); (root/'src/memory-sqlite-fts-worker.py').write_text(worker)
  (root/'scripts/memory-offline-preflight.py').write_text((Path(SCRIPT).parent/'memory-offline-preflight.py').read_text())
  master,slave=pty.openpty()
  p=subprocess.Popen(['/usr/bin/python3',str(root/'scripts/memory-offline-migrate.py'),str(self.d),str(self.proof),'test','1',self.event,'--retention-ms','86400000'],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
  os.close(slave); out=b''; sent=False; stopped=None; deadline=time.monotonic()+10
  try:
   while time.monotonic()<deadline:
    if select.select([master],[],[],.02)[0]:
     try: out+=os.read(master,65536)
     except OSError: pass
     match=re.search(rb'CONFIRM ([a-f0-9]{32})',out)
     if match and not sent: os.write(master,b'CONFIRM '+match.group(1)+b'\n'); sent=True
    if stage.startswith('worker_'):
     try: children=Path(f'/proc/{p.pid}/task/{p.pid}/children').read_text().split()
     except FileNotFoundError: children=[]
     candidates=[int(x) for x in children]
    else: candidates=[p.pid]
    for pid in candidates:
     try:
      if Path(f'/proc/{pid}/status').read_text().split('State:')[1].strip().startswith('T'): stopped=pid; break
     except FileNotFoundError: pass
    if stopped: break
    if p.poll() is not None: break
   self.assertIsNotNone(stopped, (stage,out.decode(errors='replace')))
   os.kill(p.pid,signal.SIGKILL); p.wait(timeout=5)
   if stopped!=p.pid:
    os.kill(stopped,signal.SIGKILL)
    # Wait for the SQLite transaction and inherited lock to be released.
    for _ in range(200):
     try:
      state=Path(f'/proc/{stopped}/status').read_text().split('State:')[1].strip()
      if state.startswith('Z'): break
     except FileNotFoundError: break
     time.sleep(.01)
  finally:
   if p.poll() is None: p.kill(); p.wait()
   os.close(master)
  return self.runcli()

 def test_sigkill_before_reservation_can_be_confirmed_again(self):
  code,out=self.crash_at('before_reservation'); self.assertEqual(code,0,out)
  db=sqlite3.connect(self.dst); self.assertEqual(db.execute('SELECT evidence FROM local_entries').fetchall(),[(self.event,)]); db.close()

 def test_sigkill_after_reservation_and_worker_transaction_never_replays(self):
  for stage in ('after_reservation','worker_before_commit','worker_after_commit'):
   with self.subTest(stage=stage):
    if stage!='after_reservation': self.tearDown(); self.setUp()
    code,out=self.crash_at(stage); self.assertNotEqual(code,0,out)
    audit=sqlite3.connect(self.d/'offline-migration-audit.sqlite3'); self.assertEqual(audit.execute('SELECT status FROM attempts').fetchall(),[('attempt' if stage=='after_reservation' else 'consumed',)]); audit.close()
    if self.dst.exists() and self.dst.stat().st_size:
     db=sqlite3.connect(self.dst)
     try:
      tables={r[0] for r in db.execute('SELECT name FROM sqlite_master WHERE type="table"')}
      if 'local_entries' in tables:
       rows=db.execute('SELECT evidence,text,created FROM local_entries').fetchall()
       expected=[(self.event,'fixture',self.created)] if stage=='worker_after_commit' else []
       self.assertEqual(rows,expected)
     finally: db.close()

if __name__=='__main__': unittest.main()
