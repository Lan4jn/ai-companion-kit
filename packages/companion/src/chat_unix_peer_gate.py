"""Linux Unix-stream peer gate for a future trusted local OneBot broker.

This authenticates only the Unix socket peer at connection time; it does not
identify a TCP/WS server or authenticate messages arriving from a LAN. Do not
use forwarded or caller-supplied UIDs as evidence. No production wiring here.
"""
import socket
import struct
import time


def read_trusted_frame(conn, *, expected_uid, expected_pid=None, timeout=5, max_bytes=65536):
    """Read one length-prefixed frame, after kernel peer-credential checks.

    A trusted same-UID process can impersonate any other same-UID process unless
    an independently obtained, lifecycle-managed expected_pid is supplied.
    Socket passing and PID reuse remain important limitations for PID pinning.
    """
    if (not isinstance(conn, socket.socket) or conn.family != socket.AF_UNIX or
            (conn.type & socket.SOCK_STREAM) != socket.SOCK_STREAM or
            not hasattr(socket, 'SO_PEERCRED')):
        raise PermissionError('Unix peer credentials unavailable')
    if type(expected_uid) is not int or expected_uid < 0 or (expected_pid is not None and (type(expected_pid) is not int or expected_pid <= 0)):
        raise ValueError('invalid peer policy')
    if not isinstance(timeout, (int, float)) or not 0 < timeout <= 60 or type(max_bytes) is not int or not 0 < max_bytes <= 1048576:
        raise ValueError('invalid frame limits')
    try:
        pid, uid, _ = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    except (OSError, struct.error) as exc:
        raise PermissionError('Unix peer credentials unavailable') from exc
    if pid <= 0 or uid != expected_uid or (expected_pid is not None and pid != expected_pid):
        raise PermissionError('untrusted Unix peer')
    deadline = time.monotonic() + timeout
    previous_timeout = conn.gettimeout()
    def read_exact(length):
        chunks = []
        while length:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('frame deadline exceeded')
            conn.settimeout(remaining)
            chunk = conn.recv(length)
            if not chunk:
                raise EOFError('incomplete frame')
            chunks.append(chunk)
            length -= len(chunk)
        return b''.join(chunks)
    try:
        length = struct.unpack('!I', read_exact(4))[0]
        if not 0 < length <= max_bytes:
            raise ValueError('invalid frame size')
        return read_exact(length)
    finally:
        conn.settimeout(previous_timeout)
