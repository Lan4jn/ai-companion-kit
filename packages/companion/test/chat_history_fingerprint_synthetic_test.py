import os, sqlite3, subprocess, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from chat_history_fingerprint_synthetic import Candidate

class FingerprintTest(unittest.TestCase):
 def test_forgotten_dependency_blocks_and_leaves_no_snapshot(self):
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
   c=Candidate(d+'/data.db', b'k'*32); c.add_history('old', 'synthetic secret'); token=c.snapshot(); c.prepare('turn', 'new input', 'new output', token); c.forget('old')
   self.assertEqual(c.claim('turn'), 'blocked'); c.close()
   con=sqlite3.connect(d+'/data.db'); row=con.execute('select dep from outbox').fetchone()[0]; self.assertNotIn('synthetic secret',row); con.close()
 def test_sigkill_claim_is_not_retried_and_ack_idempotent(self):
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
   db=d+'/data.db'; c=Candidate(db,b'k'*32); c.add_history('old','secret'); c.prepare('turn','input','output',c.snapshot()); c.close()
   script="from chat_history_fingerprint_synthetic import Candidate; import os,signal,sys; c=Candidate(sys.argv[1],b'k'*32); c.claim('turn'); os.kill(os.getpid(),signal.SIGKILL)"
   p=subprocess.run([sys.executable,'-c',script,db],env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'src')}); self.assertEqual(p.returncode,-9)
   c=Candidate(db,b'k'*32); self.assertEqual(c.claim('turn'),'unknown'); self.assertEqual(c.state('turn'),'unknown'); c.close()
 def test_tampered_dependency_and_ack_integrity(self):
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
   db=d+'/data.db'; c=Candidate(db,b'k'*32); c.add_history('old','secret'); c.prepare('turn','input','output',c.snapshot()); c.close()
   with sqlite3.connect(db) as x: x.execute("update outbox set dep='[]'")
   c=Candidate(db,b'k'*32)
   with self.assertRaisesRegex(ValueError,'integrity'): c.claim('turn')
   c.close()
 def test_sigkill_before_and_after_ack_commit(self):
  for phase in ('before','after'):
   with self.subTest(phase=phase), tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
    db=d+'/data.db'; c=Candidate(db,b'k'*32); c.prepare('turn','input','output',c.snapshot()); c.claim('turn'); c.close()
    script="""from chat_history_fingerprint_synthetic import Candidate
import os,signal,sys
c=Candidate(sys.argv[1],b'k'*32)
if sys.argv[2]=='before':
 c.db.execute('BEGIN IMMEDIATE'); row=c.checked('turn'); c.transition(row,'confirmed')
else: c.ack('turn')
os.kill(os.getpid(),signal.SIGKILL)
"""
    p=subprocess.run([sys.executable,'-c',script,db,phase],env={**os.environ,'PYTHONPATH':str(Path(__file__).resolve().parents[1]/'src')}); self.assertEqual(p.returncode,-9)
    c=Candidate(db,b'k'*32); self.assertEqual(c.state('turn'), 'unknown' if phase=='before' else 'confirmed'); self.assertEqual(c.claim('turn'),'unknown' if phase=='before' else 'confirmed'); c.close()
 def test_confirmed_idempotency(self):
  with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
   c=Candidate(d+'/data.db',b'k'*32); c.add_history('old','secret'); c.prepare('turn','input','output',c.snapshot()); self.assertEqual(c.claim('turn'),'claimed'); self.assertEqual(c.ack('turn'),'confirmed'); self.assertEqual(c.ack('turn'),'confirmed'); self.assertEqual(c.claim('turn'),'confirmed'); c.close()

if __name__=='__main__': unittest.main()
