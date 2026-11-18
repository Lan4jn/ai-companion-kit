import importlib.util
import os
import socket
import struct
import unittest

spec = importlib.util.spec_from_file_location('peer_gate', os.path.join(os.path.dirname(__file__), '../src/chat_unix_peer_gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class PeerGateTests(unittest.TestCase):
    def test_live_same_uid_one_frame(self):
        a, b = socket.socketpair()
        try:
            a.sendall(struct.pack('!I', 3) + b'abc')
            self.assertEqual(gate.read_trusted_frame(b, expected_uid=os.geteuid(), timeout=1), b'abc')
        finally:
            a.close(); b.close()

    def test_reject_wrong_uid_before_consuming_payload(self):
        a, b = socket.socketpair()
        try:
            a.sendall(struct.pack('!I', 1) + b'x')
            with self.assertRaises(PermissionError):
                gate.read_trusted_frame(b, expected_uid=os.geteuid() + 1, timeout=1)
            self.assertEqual(b.recv(4), struct.pack('!I', 1))
        finally:
            a.close(); b.close()

    def test_reject_tcp_and_oversize(self):
        tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            with self.assertRaises(PermissionError):
                gate.read_trusted_frame(tcp, expected_uid=os.geteuid(), timeout=1)
        finally: tcp.close()
        a, b = socket.socketpair()
        try:
            a.sendall(struct.pack('!I', 1025))
            with self.assertRaises(ValueError):
                gate.read_trusted_frame(b, expected_uid=os.geteuid(), timeout=1, max_bytes=1024)
        finally: a.close(); b.close()

    def test_pid_restriction_and_timeout(self):
        a, b = socket.socketpair()
        try:
            with self.assertRaises(PermissionError):
                gate.read_trusted_frame(b, expected_uid=os.geteuid(), expected_pid=os.getpid()+1000000, timeout=0.05)
            with self.assertRaises(TimeoutError):
                gate.read_trusted_frame(b, expected_uid=os.geteuid(), timeout=0.05)
        finally: a.close(); b.close()

if __name__ == '__main__': unittest.main()
