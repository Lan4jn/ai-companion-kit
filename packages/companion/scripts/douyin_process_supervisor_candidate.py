#!/usr/bin/python3
"""Offline-only process-supervisor candidate; never use as a login launcher.

A fixed synthetic worker runs in a PID/network/mount sandbox. No caller-supplied
commands, accounts, credentials, devices, broker or public networking. Fixture
UID 61101 is NOT allocated or reserved by this code. Host administrators must
reserve it exclusively; this is not a production trust or identity boundary.
"""
import contextlib
import os
import pathlib
import select
import signal
import socket
import subprocess
import tempfile
import time

_UID = 61101
# This pre-exec trampoline is a separate process, never a privileged Python
# preexec_fn in a threaded parent. SIGKILL on parent death covers startup too.
_LAUNCH = r'''import ctypes,os,signal,sys,time
parent=os.getppid()
if ctypes.CDLL(None,use_errno=True).prctl(1,signal.SIGKILL,0,0,0)!=0: os._exit(126)
if os.getppid()!=parent: os._exit(126)
time.sleep(float(sys.argv[1]))
os.execv(sys.argv[2],sys.argv[2:])'''
_WORKER = r'''import os,socket,subprocess,sys,time
assert os.getuid()==61101 and os.getgid()==61101 and not os.getgroups()
assert not os.path.exists(sys.argv[1])
s=socket.socket(); s.settimeout(1)
try: s.connect(('127.0.0.1',int(sys.argv[3])))
except OSError: pass
else: raise RuntimeError('host network exposed')
finally: s.close()
p=subprocess.Popen(['/usr/bin/python3','-c','import os,time; os.setsid(); time.sleep(120)',sys.argv[2]])
print('ready',flush=True)
time.sleep(120)
'''

_GUARDIAN = r'''import os,sys,tempfile
# /run is trusted here only when root-owned and not writable by other users.
s=os.stat('/run',follow_symlinks=False)
if s.st_uid != 0 or s.st_mode & 0o022: sys.exit(126)
d=tempfile.mkdtemp(prefix='dy-supervisor-',dir='/run')
fd=os.open(d,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
identity=os.fstat(fd)
print(d,flush=True)
while os.read(0,4096): pass
# Only the two exact fixture files may be removed; do not recursively delete
# attacker-created trees or follow links. Do not touch a replaced directory.
try:
 current=os.stat(d,follow_symlinks=False)
 if (current.st_dev,current.st_ino)!=(identity.st_dev,identity.st_ino): sys.exit(1)
 for name in ('worker.py','sentinel'):
  try: os.unlink(name,dir_fd=fd)
  except FileNotFoundError: pass
 os.rmdir(d)
except OSError: sys.exit(1)
'''

@contextlib.contextmanager
def private_fixture_directory():
    """An independent guardian owns the directory until the lifeline closes.

    The worker cannot write the directory. Unexpected entries or replacement
    cause retention rather than recursive removal. Guardian death is not covered.
    """
    if os.geteuid() != 0:
        raise PermissionError('fixture requires root')
    guardian = subprocess.Popen(['/usr/bin/python3', '-c', _GUARDIAN],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        close_fds=True, env={'PATH':'/usr/bin:/bin'})
    try:
        directory = guardian.stdout.readline().decode().strip()
        if not directory:
            raise RuntimeError('fixture guardian failed')
        yield directory
    finally:
        guardian.stdin.close()
        guardian.stdout.close()
        try: guardian.wait(timeout=3)
        except subprocess.TimeoutExpired:
            guardian.kill()
            guardian.wait()
            raise RuntimeError('fixture guardian timed out')
        if guardian.returncode:
            raise RuntimeError('fixture cleanup failed; retained for inspection')

def run_fixture(*, ttl=2, startup_delay=0):
    """Run a bounded, fixed offline fixture; returns non-sensitive audit fields.

    This function must itself run in a dedicated supervisor process in any
    integration; it is deliberately not connected to the existing lease.
    """
    # The fixture's fixed UID and a /proc scan do not constitute an exclusive
    # principal. No override is accepted; a trusted allocator and boundary must
    # be integrated before this launcher can safely run.
    raise RuntimeError('exclusive identity allocation is not implemented')
    if os.geteuid() != 0:
        raise PermissionError('fixture requires root')
    if type(ttl) not in (int, float) or not 0.1 <= ttl <= 30:
        raise ValueError('invalid TTL')
    if type(startup_delay) not in (int, float) or not 0 <= startup_delay <= 30:
        raise ValueError('invalid startup delay')
    # Scan is a safety check only, never an identity allocator.
    for entry in pathlib.Path('/proc').iterdir():
        if entry.name.isdigit():
            try:
                if entry.stat().st_uid == _UID:
                    raise RuntimeError('fixture UID already active')
            except FileNotFoundError:
                pass
    with private_fixture_directory() as directory, socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            conn, _ = listener.accept()
            conn.close()
        os.chmod(directory, 0o755)
        worker = pathlib.Path(directory, 'worker.py')
        worker.write_text(_WORKER, encoding='utf-8')
        os.chmod(worker, 0o644)
        sentinel = pathlib.Path(directory, 'sentinel')
        sentinel.write_text('synthetic', encoding='ascii')
        os.chown(sentinel, _UID, _UID)
        os.chmod(sentinel, 0o600)
        marker = 'fixture-' + pathlib.Path(directory).name
        args = ['/usr/bin/bwrap','--unshare-pid','--unshare-net','--unshare-ipc','--die-with-parent',
                '--ro-bind','/usr/lib64','/usr/lib64','--symlink','usr/lib64','/lib64',
                '--ro-bind','/usr/bin/python3.11','/usr/bin/python3.11','--symlink','python3.11','/usr/bin/python3',
                '--ro-bind','/usr/bin/setpriv','/usr/bin/setpriv','--ro-bind',str(worker),'/worker.py',
                '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chmod','1777','/tmp',
                '--chmod','755','/','--chmod','755','/usr','--chmod','755','/usr/bin','--clearenv',
                '--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8',
                '--','/usr/bin/setpriv',f'--reuid={_UID}',f'--regid={_UID}','--clear-groups','--no-new-privs',
                '/usr/bin/python3','/worker.py',str(sentinel),marker,str(port)]
        start = time.monotonic()
        p = subprocess.Popen(['/usr/bin/python3','-c',_LAUNCH,str(startup_delay),*args],
                             stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                             close_fds=True,start_new_session=True,env={'PATH':'/usr/bin:/bin'})
        ready = False
        reason = 'launch_failed'
        try:
            while True:
                remaining = start + ttl - time.monotonic()
                if remaining <= 0:
                    reason = 'expired'
                    break
                readable,_,_ = select.select([p.stdout],[],[],min(remaining,0.1))
                if readable:
                    line = p.stdout.readline()
                    if line == b'ready\n': ready = True
                    elif not line and p.poll() is not None: break
                if p.poll() is not None: break
        finally:
            # Group kill handles a stalled launcher. PID namespace teardown by
            # bwrap's init also kills descendants that created new sessions.
            if p.poll() is None:
                try: os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError: pass
            try: p.wait(timeout=2)
            except subprocess.TimeoutExpired: raise RuntimeError('supervisor cleanup timed out')
            if p.stdout: p.stdout.close()
        return {'reason':reason, 'ready':ready, 'reaped':p.poll() is not None,
                'sentinel_intact':sentinel.read_text(encoding='ascii') == 'synthetic',
                'network_control':ready}

if __name__ == '__main__':
    import json
    print(json.dumps(run_fixture()))
