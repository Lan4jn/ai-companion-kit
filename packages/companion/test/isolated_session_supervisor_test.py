import importlib.util
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import unittest

P = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'isolated_session_supervisor.py'
if P.exists():
    spec = importlib.util.spec_from_file_location('isolated_session_supervisor', P)
    supervisor = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(supervisor)
else:
    supervisor = None

@unittest.skipUnless(os.geteuid() == 0 and subprocess.run(['unshare','--net','true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0, 'requires root and netns')
class SupervisorTest(unittest.TestCase):
    def test_fd_namespace_deny_and_cleanup(self):
        self.assertIsNotNone(supervisor, 'system supervisor not implemented')
        server=socket.socket(); server.bind(('127.0.0.1',0)); server.listen()
        code='''import os,socket,sys\ns=socket.socket(fileno=3)\ns.sendall(b"POST /request HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: 0\\r\\n\\r\\n")\nr=s.recv(1024)\nn=socket.socket()\ntry: n.connect(("127.0.0.1", int(sys.argv[1]))); isolated=False\nexcept OSError: isolated=True\nassert os.getuid()==65534 and isolated and b"403" in r\n'''
        try:
            session=supervisor.IsolatedSession(['/usr/bin/python3','-c',code,str(server.getsockname()[1])],uid=65534,gid=65534,ttl=10)
            session.start()
            self.assertEqual(session._process.wait(timeout=5),0)
            session.close(); session.close()
            session=supervisor.IsolatedSession(['/usr/bin/sleep','30'],uid=65534,gid=65534,ttl=10).start()
            pid=session.pid
            session.close()
            with self.assertRaises(ProcessLookupError): os.kill(pid,0)
        finally: server.close()

    def test_delegated_broker_and_ipc_descriptors(self):
        broker, worker_broker = socket.socketpair()
        ipc, worker_ipc = socket.socketpair()
        code = '''import os,socket\na=socket.socket(fileno=3); b=socket.socket(fileno=4)\na.sendall(b"broker"); b.sendall(b"ipc")\nassert a.recv(8)==b"ok" and b.recv(8)==b"go"\n'''
        try:
            session = supervisor.IsolatedSession(['/usr/bin/python3','-c',code], uid=65534, gid=65534, ttl=10,
                broker_fd=worker_broker.fileno(), ipc_fd=worker_ipc.fileno()).start()
            worker_broker.close(); worker_ipc.close()
            broker.settimeout(5); ipc.settimeout(5)
            self.assertEqual(broker.recv(8), b'broker'); self.assertEqual(ipc.recv(8), b'ipc')
            broker.sendall(b'ok'); ipc.sendall(b'go')
            self.assertEqual(session._process.wait(timeout=5), 0)
            session.close()
        finally:
            broker.close(); ipc.close(); worker_broker.close(); worker_ipc.close()

    def test_node_ipc_uses_separate_channel(self):
        broker, worker_broker = socket.socketpair()
        ipc, worker_ipc = socket.socketpair()
        code = 'process.send({type:"ready"}); process.on("message", m => {if(m.go) process.exit(0)})'
        try:
            session = supervisor.IsolatedSession(['/usr/bin/node','-e',code], uid=65534, gid=65534, ttl=10,
                broker_fd=worker_broker.fileno(), ipc_fd=worker_ipc.fileno(),
                worker_env={'NODE_CHANNEL_FD':'4','NODE_CHANNEL_SERIALIZATION_MODE':'json'}).start()
            worker_broker.close(); worker_ipc.close(); ipc.settimeout(5)
            self.assertIn(b'"ready"',ipc.recv(1024))
            ipc.sendall(b'{"go":true}\n')
            self.assertEqual(session._process.wait(timeout=5),0)
            session.close()
        finally:
            broker.close(); ipc.close(); worker_broker.close(); worker_ipc.close()

    def test_expiry_kills_worker(self):
        session=supervisor.IsolatedSession(['/usr/bin/sleep','30'],uid=65534,gid=65534,ttl=1).start()
        pid=session.pid
        self.assertIsNotNone(session._process.wait(timeout=4))
        session.close()
        with self.assertRaises(ProcessLookupError): os.kill(pid,0)

    def test_invalid_identity_and_timeout_rejected(self):
        self.assertIsNotNone(supervisor, 'system supervisor not implemented')
        for uid,gid,ttl in [(0,1,5),(1,0,5),(1,1,0),(1,1,3601)]:
            with self.assertRaises(ValueError): supervisor.IsolatedSession(['/bin/true'],uid=uid,gid=gid,ttl=ttl)

if __name__ == '__main__': unittest.main()
