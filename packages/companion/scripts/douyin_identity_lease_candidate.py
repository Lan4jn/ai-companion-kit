#!/usr/bin/python3
"""Offline-only, one-shot identity reservation candidate, NOT a launcher.

The operator must exclusively reserve these pre-created accounts and IDs across
all NSS, subordinate IDs, host services and other allocators. Never delete the
ledger or reuse its IDs, including after crashes and partial failures. This
module cannot enforce those administrative prerequisites. No production wiring.
"""
import grp
import os
import pathlib
import pwd
import stat


def _validate_identity(uid, gid, name):
    # These checks are additional rejection checks, not an OS-wide allocator.
    if type(uid) is not int or type(gid) is not int or uid < 1000 or gid < 1000 or uid > 2147483646 or gid > 2147483646:
        raise ValueError('invalid identity')
    if not isinstance(name, str) or name != 'dyfixture' + str(uid):
        raise ValueError('invalid dedicated account name')
    try:
        p, g = pwd.getpwuid(uid), grp.getgrgid(gid)
    except KeyError as exc:
        raise RuntimeError('reserved account or group missing') from exc
    if (p.pw_name != name or p.pw_uid != uid or p.pw_gid != gid or
        p.pw_dir != '/nonexistent' or p.pw_shell not in ('/sbin/nologin', '/usr/sbin/nologin') or
        g.gr_gid != gid or g.gr_name != name or g.gr_mem):
        raise RuntimeError('reserved account or group mismatch')
    # NSS reverse lookup can hide numeric aliases; enumerate as an additional
    # rejection check. Enumeration may be incomplete and is not a reservation.
    users, groups = pwd.getpwall(), grp.getgrall()
    if any((u.pw_uid == uid or u.pw_gid == gid or u.pw_name == name) and
           (u.pw_name != name or u.pw_uid != uid or u.pw_gid != gid)
           for u in users):
        raise RuntimeError('reserved identity NSS conflict')
    if any((x.gr_gid == gid or x.gr_name == name) and
           (x.gr_gid != gid or x.gr_name != name) for x in groups):
        raise RuntimeError('reserved identity NSS conflict')
    if any(x.gr_gid != gid and name in x.gr_mem for x in groups):
        raise RuntimeError('reserved account has supplemental groups')
    # Check every UID/GID in status, including saved and filesystem IDs and
    # supplementary groups. A scan can race; reservation is still mandatory.
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            lines = (entry / 'status').read_text().splitlines()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise RuntimeError('cannot inspect process identities') from exc
        fields = {line.split(':', 1)[0]: line.split(':', 1)[1].split()
                  for line in lines if ':' in line}
        try:
            if uid in map(int, fields['Uid']) or gid in map(int, fields['Gid']) or gid in map(int, fields['Groups']):
                raise RuntimeError('reserved identity already active')
        except (KeyError, ValueError) as exc:
            raise RuntimeError('cannot inspect process identities') from exc


def _open_directory(path):
    # Walk each component without following symlinks; no untrusted writable
    # ancestor may replace the ledger. Use a dirfd throughout the operation.
    p = pathlib.PurePosixPath(path)
    if not p.is_absolute() or '..' in p.parts:
        raise ValueError('ledger path must be absolute')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in p.parts[1:]:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = nxt
            s = os.fstat(fd)
            if s.st_uid != 0 or s.st_mode & 0o022:
                raise RuntimeError('untrusted ledger path')
        return fd
    except BaseException:
        os.close(fd)
        raise


def burn_reserved_identity(ledger_directory, whitelist):
    """Permanently burn one pre-reserved principal; never release or reclaim.

    Requires a pre-existing root-owned non-writable ledger and ancestors.
    Returns (uid, gid, account_name); no process is launched or signalled.
    A failed operation may burn an ID; this is intentional and fail-closed.
    """
    if os.geteuid() != 0:
        raise PermissionError('root required')
    if not isinstance(whitelist, (tuple, list)) or not 1 <= len(whitelist) <= 64:
        raise ValueError('invalid whitelist')
    # Reject ambiguous duplicate identities before touching the ledger.
    if any(not isinstance(row, (tuple, list)) or len(row) != 3 for row in whitelist):
        raise ValueError('invalid whitelist')
    if len({row[0] for row in whitelist}) != len(whitelist) or len({row[1] for row in whitelist}) != len(whitelist):
        raise ValueError('duplicate identity')
    directory = _open_directory(ledger_directory)
    try:
        for uid, gid, name in whitelist:
            # Validate formatting even if a previous reservation already exists.
            if type(uid) is not int or type(gid) is not int or uid < 1000 or gid < 1000 or uid > 2147483646 or gid > 2147483646 or name != 'dyfixture' + str(uid):
                raise ValueError('invalid identity')
            # Permanently reserve both dimensions independently. Never roll back
            # either marker after a crash or conflict; partial burns are safe.
            try:
                gfd = os.open('gid-' + str(gid), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            except FileExistsError:
                continue
            try:
                os.fsync(gfd)
            finally:
                os.close(gfd)
            os.fsync(directory)
            try:
                fd = os.open('uid-' + str(uid), os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
            except FileExistsError:
                continue
            try:
                os.write(fd, (str(uid) + ':' + str(gid) + '\n').encode('ascii'))
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(directory)
            _validate_identity(uid, gid, name)
            return uid, gid, name
        raise RuntimeError('reserved identities exhausted')
    finally:
        os.close(directory)
