import os, socket, tempfile, threading, time, unittest, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
try:
    from synthetic_rfb_broker import SingleUseBroker
except ImportError:
    SingleUseBroker = None

class BrokerTest(unittest.TestCase):
    def test_single_use_disconnect_and_replay(self):
        self.assertIsNotNone(SingleUseBroker, 'single-use broker not implemented')
        with tempfile.TemporaryDirectory() as d:
            upstream = socket.socket(socket.AF_UNIX)
            upstream.bind(d + '/upstream'); upstream.listen()
            broker = SingleUseBroker(d + '/access', d + '/upstream', 'secret', time.monotonic() + 3)
            broker.start()
            c = socket.socket(socket.AF_UNIX); c.settimeout(2); c.connect(d + '/access'); c.sendall(b'secret\n')
            peer, _ = upstream.accept(); peer.sendall(b'RFB 003.008\n'); self.assertEqual(c.recv(12), b'RFB 003.008\n')
            replay = socket.socket(socket.AF_UNIX); replay.settimeout(2); replay.connect(d + '/access'); replay.sendall(b'secret\n')
            try:
                self.assertEqual(replay.recv(1), b'')
            except ConnectionResetError:
                pass
            replay.close()
            c.close(); peer.close(); self.assertTrue(broker.done.wait(2)); broker.join(2)
            with self.assertRaises(OSError):
                replay = socket.socket(socket.AF_UNIX)
                try: replay.connect(d + '/access')
                finally: replay.close()
            self.assertFalse(os.path.exists(d + '/access'))
            upstream.close()

    def test_competing_clients_and_expiry(self):
        with tempfile.TemporaryDirectory() as d:
            upstream = socket.socket(socket.AF_UNIX); upstream.bind(d + '/up'); upstream.listen(); upstream.settimeout(.5)
            broker = SingleUseBroker(d + '/access', d + '/up', 'secret', time.monotonic() + 1)
            broker.start()
            barrier = threading.Barrier(3); sockets = []
            def connect():
                c = socket.socket(socket.AF_UNIX); c.settimeout(2); c.connect(d + '/access'); sockets.append(c)
                barrier.wait(); c.sendall(b'secret\n')
            threads = [threading.Thread(target=connect) for _ in range(2)]
            for t in threads: t.start()
            barrier.wait()
            for t in threads: t.join()
            peer, _ = upstream.accept()
            with self.assertRaises(socket.timeout): upstream.accept()
            self.assertTrue(broker.done.wait(2)); broker.join(2)
            self.assertFalse(os.path.exists(d + '/access'))
            peer.settimeout(1); self.assertEqual(peer.recv(1), b'')
            for c in sockets: c.close()
            peer.close(); upstream.close()

    def test_invalid_token_does_not_consume_grant(self):
        with tempfile.TemporaryDirectory() as d:
            upstream = socket.socket(socket.AF_UNIX); upstream.bind(d + '/up'); upstream.listen(); upstream.settimeout(2)
            broker = SingleUseBroker(d + '/access', d + '/up', 'secret', time.monotonic() + 2); broker.start()
            bad = socket.socket(socket.AF_UNIX); bad.settimeout(2); bad.connect(d + '/access'); bad.sendall(b'wrong\n'); self.assertEqual(bad.recv(1), b''); bad.close()
            good = socket.socket(socket.AF_UNIX); good.connect(d + '/access'); good.sendall(b'secret\n')
            peer, _ = upstream.accept(); good.close(); peer.close(); broker.join(2); upstream.close()
            self.assertFalse(os.path.exists(d + '/access'))

if __name__ == '__main__': unittest.main()
