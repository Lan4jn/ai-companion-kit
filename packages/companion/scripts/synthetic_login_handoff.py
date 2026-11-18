#!/usr/bin/env python3
"""Synthetic-only handoff state machine; NOT a platform credential importer.

No networking, browser control, or account data. Inputs are fixed test fixtures.
This deliberately cannot be used to import actual credentials.
"""
import hashlib
import hmac
import os
import secrets
import stat
import tempfile
import threading
import time
from pathlib import Path

FIXTURE = b'SYNTHETIC-SESSION-NOT-A-CREDENTIAL\n'


class Denied(Exception):
    pass


class SyntheticHandoff:
    def __init__(self, directory, ttl=30, clock=time.monotonic):
        if not 0 < ttl <= 300:
            raise ValueError('invalid timeout')
        self.directory = Path(directory)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise Denied('private owned directory required')
        self.clock = clock
        self.deadline = clock() + ttl
        self._digest = None
        self._lock = threading.Lock()
        self.state = 'new'

    def start(self):
        with self._lock:
            if self.state != 'new' or self.clock() >= self.deadline:
                self.state = 'closed'
                raise Denied('session unavailable')
            token = secrets.token_urlsafe(32)
            self._digest = hashlib.sha256(token.encode()).digest()
            self.state = 'waiting'
            return token

    def close(self):
        with self._lock:
            self._digest = None
            self.state = 'closed'

    def complete(self, token, *, owner_approved, platform_verified, candidate):
        """Consume a fixture session exactly once, regardless of outcome.

        Boolean arguments simulate independent checks; they are not security
        evidence and must never be accepted from an unauthenticated client.
        """
        with self._lock:
            if self.state != 'waiting':
                raise Denied('session unavailable')
            # An incorrect token must not be able to consume a valid session.
            supplied = hashlib.sha256(token.encode()).digest() if isinstance(token, str) else b''
            if self._digest is None or not hmac.compare_digest(supplied, self._digest):
                raise Denied('session unavailable')
            self._digest = None
            self.state = 'closed'
            if self.clock() >= self.deadline or owner_approved is not True or platform_verified is not True or candidate != FIXTURE:
                raise Denied('handoff rejected')
            self._write_fixture()
            self.state = 'imported'

    def _write_fixture(self):
        # Open and pin the validated directory. Never follow the target symlink;
        # rename replaces a symlink itself rather than its destination.
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        dfd = os.open(self.directory, flags)
        tmp = None
        try:
            info = os.fstat(dfd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise Denied('private owned directory required')
            tmp = '.synthetic-' + secrets.token_hex(16)
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
            try:
                with os.fdopen(fd, 'wb') as out:
                    out.write(FIXTURE)
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(tmp, 'synthetic-session.fixture', src_dir_fd=dfd, dst_dir_fd=dfd)
                tmp = None
                os.fsync(dfd)
            finally:
                if tmp is not None:
                    try:
                        os.unlink(tmp, dir_fd=dfd)
                    except FileNotFoundError:
                        pass
        finally:
            os.close(dfd)
