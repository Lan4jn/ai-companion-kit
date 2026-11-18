"""Opt-in local owner-message channel to one supervised child, not an HTTP bridge.

The child is trusted to attest upstream identity. Same-UID processes are not
isolated, and a connected descriptor can be delegated. Never retry unknown sends.
"""
import json
import os
import re
import socket
import struct
import subprocess
import tempfile
import threading

from chat_unix_peer_gate import read_trusted_frame


class LocalChatSupervisor:
    def __init__(self, *, enabled=False, owner_id=None, directory=None, command=None):
        if enabled is not True:
            raise ValueError('disabled')
        if not isinstance(owner_id, str) or not re.fullmatch(r'[1-9][0-9]*', owner_id):
            raise ValueError('invalid owner')
        if not isinstance(directory, str) or not os.path.isabs(directory):
            raise ValueError('private directory required')
        st = os.lstat(directory)
        if not os.path.isdir(directory) or os.path.islink(directory) or st.st_uid != os.getuid() or st.st_mode & 0o077:
            raise ValueError('private directory required')
        if not isinstance(command, list) or not command or any(not isinstance(x, str) or not x for x in command):
            raise ValueError('command required')
        self.owner = owner_id
        self.lock = threading.Lock()
        self.conn = None
        self.proc = None
        self.listener = None
        self.folder = tempfile.mkdtemp(prefix='chat-peer-', dir=directory)
        self.path = os.path.join(self.folder, 'peer.sock')
        try:
            self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.listener.bind(self.path)
            os.chmod(self.path, 0o600)
            self.listener.listen(1)
            self.listener.settimeout(5)
            env = os.environ.copy()
            env['CHAT_LOCAL_SOCKET'] = self.path
            self.proc = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
            self.conn, _ = self.listener.accept()
            self.listener.close()
            self.listener = None
            # Check credentials before any request is accepted, and retain this
            # connected descriptor; never trust a claimed pid in the payload.
            pid, uid, _ = struct.unpack('3i', self.conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
            if pid != self.proc.pid or uid != os.getuid() or self.proc.poll() is not None:
                raise PermissionError('untrusted child')
        except BaseException:
            self.close()
            raise

    def _read(self):
        payload = read_trusted_frame(self.conn, expected_uid=os.getuid(), expected_pid=self.proc.pid, timeout=5, max_bytes=65536)
        def unique(pairs):
            obj = {}
            for key, value in pairs:
                if key in obj:
                    raise ValueError('duplicate key')
                obj[key] = value
            return obj
        return json.loads(payload.decode('utf-8'), object_pairs_hook=unique)

    def _write(self, value):
        data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        if not 0 < len(data) <= 65536:
            raise ValueError('invalid frame')
        self.conn.settimeout(5)
        self.conn.sendall(struct.pack('!I', len(data)) + data)

    def receive(self):
        with self.lock:
            try:
                message = self._read()
                if (type(message) is not dict or set(message) != {'type', 'sender', 'id', 'text'} or
                    message['type'] != 'message' or message['sender'] != self.owner or
                    not isinstance(message['id'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', message['id']) or
                    not isinstance(message['text'], str) or not message['text'] or len(message['text'].encode()) > 32768 or
                    re.search(r'\[CQ:', message['text'], re.I)):
                    raise ValueError('invalid owner message')
                return {'id': message['id'], 'text': message['text']}
            except Exception:
                self._disconnect()
                raise

    def send(self, destination, text):
        if (destination != 'private:' + self.owner or not isinstance(text, str) or not text or
            len(text.encode('utf-8')) > 32768 or re.search(r'\[CQ:', text, re.I)):
            return {'ok': False, 'outcome': 'permanent'}
        with self.lock:
            try:
                self._write({'type': 'send', 'text': text})
                result = self._read()
                if result == {'type': 'result', 'status': 'ok'}:
                    return {'ok': True}
            except Exception:
                pass
            self._disconnect()
            return {'ok': False, 'outcome': 'unknown'}

    def _disconnect(self):
        if self.conn is not None:
            self.conn.close()
            self.conn = None

    def close(self):
        self._disconnect()
        if self.listener is not None:
            self.listener.close()
            self.listener = None
        if self.proc is not None:
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
            self.proc = None
        if self.folder:
            try:
                os.unlink(self.path)
            except FileNotFoundError:
                pass
            os.rmdir(self.folder)
            self.folder = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
