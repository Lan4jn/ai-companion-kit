import os, socket, struct, subprocess, sys, time, unittest
import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'isolated-login-prototype.py'

class PrototypeTest(unittest.TestCase):
    def test_window_title_requires_exact_marker(self):
        sys.path.insert(0, str(SCRIPT.parent))
        try:
            spec = importlib.util.spec_from_file_location('isolated_login_prototype', SCRIPT)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        marker = 'synthetic-approved-test'
        self.assertFalse(module.approved_window('  0x400003 "data:text/html,document.title=\"synthetic-approved-test\" - Google Chrome for Testing": ()', marker))
        self.assertTrue(module.approved_window('  0x400003 "synthetic-approved-test - Google Chrome for Testing": ()', marker))
        self.assertFalse(module.approved_window('  0x400003 "synthetic-approved-test-evil - Google Chrome for Testing": ()', marker))

    def test_deadline_cleans_up_even_without_interaction(self):
        env = {**os.environ, 'SYNTHETIC_HANDOFF_TTL': '2'}
        p = subprocess.Popen([sys.executable, str(SCRIPT)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        try:
            line = p.stdout.readline().strip()
            self.assertTrue(line.startswith('SOCKET='), line)
            path = line[7:]
            out, err = p.communicate(timeout=12)
            self.assertEqual(p.returncode, 0, err)
            self.assertFalse(os.path.exists(path))
        finally:
            if p.poll() is None:
                p.kill()
                p.communicate()

    def test_synthetic_rfb_pointer_and_teardown(self):
        p = subprocess.Popen([sys.executable, str(SCRIPT)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            line = p.stdout.readline().strip()
            self.assertTrue(line.startswith('SOCKET='), line)
            path = line[7:]
            token_line = p.stdout.readline().strip()
            self.assertTrue(token_line.startswith('TOKEN='))
            token = token_line[6:]
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertNotEqual(os.stat(path).st_uid, 0, 'RFB endpoint must run as a non-root UID')
            self.assertEqual(os.stat(os.path.dirname(path)).st_mode & 0o777, 0o700)
            s = socket.socket(socket.AF_UNIX)
            self.addCleanup(s.close)
            s.settimeout(10)
            s.connect(path)
            s.sendall((token + '\n').encode())
            def read(n):
                data = b''
                while len(data) < n:
                    part = s.recv(n-len(data))
                    if not part: raise EOFError()
                    data += part
                return data
            self.assertEqual(read(12), b'RFB 003.008\n')
            s.sendall(b'RFB 003.008\n')
            count = read(1)[0]; self.assertIn(1, read(count)); s.sendall(b'\x01')
            self.assertEqual(read(4), b'\0'*4)
            s.sendall(b'\x01')
            header = read(24)
            width, height = struct.unpack('>HH', header[:4])
            read(struct.unpack('>I', header[20:24])[0])
            self.assertGreaterEqual(width, 800); self.assertGreaterEqual(height, 600)
            # Request 32-bit little-endian true-colour raw rectangles.
            s.sendall(b'\0\0\0\0' + struct.pack('>BBBBHHHBBBxxx', 32,24,0,1,255,255,255,16,8,0))
            s.sendall(b'\x02\0\0\x01' + struct.pack('>i',0))
            def pixel():
                s.sendall(struct.pack('>BBHHHH',3,0,300,300,1,1))
                self.assertEqual(read(1), b'\0'); read(1)
                rects = struct.unpack('>H',read(2))[0]; self.assertEqual(rects,1)
                x,y,w,h,enc = struct.unpack('>HHHHi',read(12)); self.assertEqual((w,h,enc),(1,1,0))
                return read(4)
            # Socket readiness does not imply Chromium's synthetic page is rendered.
            # Wait for its known red background rather than a fixed startup delay.
            deadline = time.monotonic() + 20
            while True:
                before = pixel()
                if before[:3] == b'\x00\x00\xff': break
                self.assertLess(time.monotonic(), deadline, 'synthetic page did not render red')
                time.sleep(.1)
            fixture = Path(path).parent / 'synthetic-session.fixture'
            self.assertFalse(fixture.exists(), 'fixture imported before pointer interaction')
            # A stray release must not count as a complete interaction.
            s.sendall(struct.pack('>BBHH',5,0,300,300))
            time.sleep(.5)
            self.assertFalse(fixture.exists(), 'fixture imported after release without press')
            s.sendall(struct.pack('>BBHH',5,1,300,300)); s.sendall(struct.pack('>BBHH',5,0,300,300))
            time.sleep(1)
            self.assertNotEqual(pixel(),before, 'trusted pointer did not change page')
            fixture = Path(path).parent / 'synthetic-session.fixture'
            for _ in range(50):
                if fixture.exists(): break
                time.sleep(.1)
            self.assertEqual(fixture.read_bytes(), b'SYNTHETIC-SESSION-NOT-A-CREDENTIAL\n')
            self.assertEqual(fixture.stat().st_mode & 0o777, 0o600)
            children_file = Path(f'/proc/{p.pid}/task/{p.pid}/children')
            child_ids = [int(pid) for pid in children_file.read_text().split()]
            self.assertTrue(child_ids, 'isolated child process missing')
            s.close()
            out, err = p.communicate(timeout=10)
            self.assertEqual(p.returncode, 0, err)
            for pid in child_ids:
                with self.assertRaises(ProcessLookupError): os.killpg(pid, 0)
            self.assertFalse(os.path.exists(path))
        finally:
            p.terminate()
            try: out,err = p.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill(); out,err = p.communicate(); self.fail('launcher failed to terminate')
            if err: print(err, file=sys.stderr)
            if 'path' in locals(): self.assertFalse(os.path.exists(path))

if __name__ == '__main__': unittest.main()
