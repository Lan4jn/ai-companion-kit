import json, os, sqlite3, subprocess, tempfile, unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1] / 'src/memory-sqlite-fts-worker.py'

class WorkerAuthorization(unittest.TestCase):
    def test_direct_synthetic_record_cannot_create_target(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as d:
            target = Path(d) / 'target.sqlite3'
            scope = {'tenant':'test','platform':'qq','type':'private','session':'private:1','user':'1'}
            request = {'operation':'migrateLegacyEvidence','path':str(target),'scope':scope,'source':'qq-private-message','retentionMs':86400000,'record':{'scope':scope,'source':'qq-private-message','evidence':'onebot-message:42','text':'forged','created_at':1}}
            proc = subprocess.run(['/usr/bin/python3',str(WORKER)], input=json.dumps(request), text=True, capture_output=True)
            self.assertNotEqual(proc.returncode, 0, proc.stdout)
            self.assertFalse(target.exists())

if __name__ == '__main__': unittest.main()
