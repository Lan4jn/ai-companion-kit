"""Synthetic-only Unix socket broker. Not an SSH authentication service."""
import hmac
import os
import select
import socket
import threading
import time


class SingleUseBroker:
    def __init__(self, path, upstream, token, deadline):
        self.path, self.upstream, self.deadline = path, upstream, deadline
        self.token = token.encode('ascii')
        self.done = threading.Event()
        self.lock = threading.Lock()
        self.claimed = False
        self.clients = set()
        self.listener = None
        self.thread = None

    def start(self):
        self.listener = socket.socket(socket.AF_UNIX)
        self.listener.bind(self.path)
        os.chmod(self.path, 0o600)
        self.listener.listen(16)
        self.listener.settimeout(.1)
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        workers = []
        try:
            while not self.done.is_set() and time.monotonic() < self.deadline:
                try:
                    client, _ = self.listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                with self.lock:
                    if self.claimed or len(self.clients) >= 16:
                        client.close()
                        continue
                    self.clients.add(client)
                worker = threading.Thread(target=self._client, args=(client,), daemon=True)
                workers.append(worker)
                worker.start()
        finally:
            self.done.set()
            self.listener.close()
            with self.lock:
                for client in list(self.clients):
                    try: client.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
            for worker in workers: worker.join(timeout=2)
            try: os.unlink(self.path)
            except FileNotFoundError: pass

    def _client(self, client):
        upstream = None
        claimed = False
        try:
            client.settimeout(.2)
            supplied = bytearray()
            while time.monotonic() < self.deadline and not self.done.is_set():
                try: char = client.recv(1)
                except socket.timeout: continue
                if not char: return
                if char == b'\n': break
                supplied += char
                if len(supplied) > len(self.token): return
            else: return
            if not hmac.compare_digest(supplied, self.token): return
            with self.lock:
                if self.claimed or self.done.is_set() or time.monotonic() >= self.deadline: return
                self.claimed = claimed = True
            upstream = socket.socket(socket.AF_UNIX)
            upstream.connect(self.upstream)
            client.setblocking(False); upstream.setblocking(False)
            while not self.done.is_set() and time.monotonic() < self.deadline:
                readable, _, _ = select.select([client, upstream], [], [], min(.1, max(0, self.deadline-time.monotonic())))
                for source in readable:
                    data = source.recv(65536)
                    if not data: return
                    dest = upstream if source is client else client
                    dest.setblocking(True)
                    dest.settimeout(min(1, max(.001, self.deadline-time.monotonic())))
                    dest.sendall(data)
                    dest.setblocking(False)
        except (OSError, ValueError):
            pass
        finally:
            if upstream: upstream.close()
            client.close()
            with self.lock: self.clients.discard(client)
            if claimed: self.done.set()

    def close(self):
        self.done.set()
        if self.thread: self.thread.join(timeout=4)

    def join(self, timeout=None):
        self.thread.join(timeout)
