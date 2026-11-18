#!/usr/bin/env python3
"""Offline fixture UID leases, not an OS-wide account allocator.

The caller MUST exclusively reserve the supplied numeric range outside this
module. Leases are burned permanently, including after crashes; never remove
the ledger or reuse a range while any process or owned files may remain.
No production entry point uses this module.
"""
import fcntl
import os
import stat


def allocate_fixture_uid(directory, first, last):
    if os.geteuid() != 0 or type(first) is not int or type(last) is not int or not (1 <= first <= last < 2**31):
        raise ValueError('root and valid pre-reserved UID range required')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    d = os.open(directory, flags)
    try:
        info = os.fstat(d)
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise PermissionError('ledger directory must be root-owned mode 0700')
        fd = os.open('uid-ledger', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=d)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_nlink != 1 or stat.S_IMODE(st.st_mode) != 0o600:
                raise PermissionError('unsafe UID ledger')
            with os.fdopen(os.dup(fd), 'r', encoding='ascii') as f:
                lines = f.read().splitlines()
            header = f'{first}:{last}'
            if not lines:
                os.write(fd, (header + '\n').encode('ascii'))
                os.fsync(fd)
                os.fsync(d)
                lines = [header]
            if lines[0] != header:
                raise ValueError('reserved range changed')
            try:
                leases = [int(line) for line in lines[1:]]
            except ValueError as exc:
                raise ValueError('corrupt UID ledger') from exc
            if leases != list(range(first, first + len(leases))) or any(x > last for x in leases):
                raise ValueError('corrupt UID ledger')
            uid = first + len(leases)
            if uid > last:
                raise RuntimeError('reserved UID range exhausted')
            os.lseek(fd, 0, os.SEEK_END)
            data = f'{uid}\n'.encode('ascii')
            if os.write(fd, data) != len(data):
                raise OSError('short UID ledger write')
            os.fsync(fd)
            return uid
        finally:
            os.close(fd)
    finally:
        os.close(d)
