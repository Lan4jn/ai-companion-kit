import json
import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'src'))
from chat_local_supervisor import LocalChatSupervisor

WORKER = r'''
import json, os, socket, struct
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.connect(os.environ['CHAT_LOCAL_SOCKET'])
def put(o):
 b=json.dumps(o).encode();s.sendall(struct.pack('!I',len(b))+b)
def get():
 def read(n):
  b=b''
  while len(b)<n:
   c=s.recv(n-len(b))
   if not c: raise EOFError()
   b+=c
  return b
 return json.loads(read(struct.unpack('!I',read(4))[0]))
put({'type':'message','sender':'123','id':'1','text':'hello'})
a=get()
if a != {'type':'send','text':'reply'}: raise ValueError(a)
put({'type':'result','status':'ok'})
get()
s.close()
'''

class SupervisorTest(unittest.TestCase):
 def test_supervised_owner_and_unknown(self):
  with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as root:
   worker=pathlib.Path(root)/'worker.py'; worker.write_text(WORKER)
   with LocalChatSupervisor(enabled=True, owner_id='123', directory=root, command=[sys.executable,str(worker)]) as proxy:
    self.assertEqual(proxy.receive(), {'id':'1','text':'hello'})
    self.assertEqual(proxy.send('private:999','reply'), {'ok':False,'outcome':'permanent'})
    self.assertEqual(proxy.send('private:123','reply'), {'ok':True})
    self.assertEqual(proxy.send('private:123','second'), {'ok':False,'outcome':'unknown'})
 def test_rejects_untrusted_sender(self):
  with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as root:
   worker=pathlib.Path(root)/'worker.py'
   worker.write_text(WORKER.replace("'sender':'123'", "'sender':'999'"))
   with LocalChatSupervisor(enabled=True, owner_id='123', directory=root, command=[sys.executable,str(worker)]) as proxy:
    with self.assertRaisesRegex(ValueError,'invalid owner message'):
     proxy.receive()
    self.assertEqual(proxy.send('private:123','reply'), {'ok':False,'outcome':'unknown'})
 def test_disabled(self):
  with self.assertRaisesRegex(ValueError,'disabled'):
   LocalChatSupervisor()

if __name__ == '__main__': unittest.main()
