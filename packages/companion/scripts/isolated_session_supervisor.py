#!/usr/bin/env python3
"""Fail-closed Linux session primitive; not a real-platform login service.

Trusted callers supply fixed commands and own the delegated FD copies. Default
FD 3 denies all requests. Explicit delegation maps broker to 3 and Node IPC to
4; the caller owns and closes the broker and its own descriptor copies. This
primitive alone is not a production sandbox or authorization for official sites.
"""
import os
import signal
import socket
import subprocess
import threading
import time
import sys

# Duplicate sources before remapping, including when sources collide with 3/4.
_WRAPPER = '''import os,sys,fcntl
n=int(sys.argv[1]); fds=[int(x) for x in sys.argv[2:2+n]]
tmp=[fcntl.fcntl(fd,fcntl.F_DUPFD_CLOEXEC,10) for fd in fds]
for i,fd in enumerate(tmp): os.dup2(fd,3+i,inheritable=True)
for fd in tmp: os.close(fd)
os.execv(sys.argv[2+n],sys.argv[2+n:])'''

# PID 1 remains privileged but never executes worker code in-process. Its pipe is
# held only by the supervisor; EOF destroys the PID namespace even if workers
# start new sessions. No numeric PID is used for cleanup.
_INIT = '''import os,sys,subprocess,threading,signal,time,json
fd=int(sys.argv[1]); ready=threading.Event(); child=None
def watch():
 while True:
  data=os.read(fd,1)
  if not data: os._exit(125)
  if data==b"T":
   ready.wait()
   try: signal.pidfd_send_signal(child,signal.SIGTERM)
   except ProcessLookupError: pass
   time.sleep(5); os._exit(125)
threading.Thread(target=watch,daemon=True).start()
if os.environ.get('NODE_TEST_CONTEXT') == 'synthetic-isolated-web':
 subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True)
args=sys.argv[2:]; sources=tuple(int(x) for x in os.environ.pop("SESSION_SOURCE_FDS").split(","))
if args[0]=='/usr/bin/bwrap':
 r,w=os.pipe2(os.O_CLOEXEC)
 p=subprocess.Popen([args[0],'--info-fd',str(w),*args[1:]],pass_fds=(*sources,w))
 os.close(w)
 with os.fdopen(r,'rb') as stream: info=json.load(stream)
 child=os.pidfd_open(info['child-pid'])
else:
 p=subprocess.Popen(args,pass_fds=sources)
 child=os.pidfd_open(p.pid)
ready.set()
rc=p.wait(); sys.exit(rc if rc>=0 else 128-rc)'''

class IsolatedSession:
    def __init__(self, command, *, uid, gid, ttl=180, broker_fd=None, ipc_fd=None, worker_env=None, fixture_sandbox=None):
        if (not isinstance(command, (list, tuple)) or not command or
            any(not isinstance(x, str) or not x or '\0' in x for x in command) or
            not os.path.isabs(command[0]) or type(uid) is not int or uid <= 0 or
            type(gid) is not int or gid <= 0 or type(ttl) not in (int, float) or
            not 1 <= ttl <= 3600):
            raise ValueError('invalid isolated session')
        if (broker_fd is None) != (ipc_fd is None) or (broker_fd is not None and
            (type(broker_fd) is not int or type(ipc_fd) is not int or broker_fd < 3 or ipc_fd < 3 or broker_fd == ipc_fd)):
            raise ValueError('invalid delegated descriptors')
        allowed_env = {'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_TEST_CONTEXT',
                       'DOUYIN_LOGIN_SESSION_DIR', 'HOME', 'TMPDIR'}
        worker_env = {} if worker_env is None else worker_env
        if (not isinstance(worker_env, dict) or any(k not in allowed_env or not isinstance(v, str) or '\0' in v for k,v in worker_env.items()) or
            ('NODE_CHANNEL_FD' in worker_env and (ipc_fd is None or worker_env['NODE_CHANNEL_FD'] != '4'))):
            raise ValueError('invalid worker environment')
        self._worker_env = dict(worker_env)
        if fixture_sandbox is not None:
            if (worker_env.get('NODE_TEST_CONTEXT') != 'synthetic-isolated-web' or
                not isinstance(fixture_sandbox, (list, tuple)) or not fixture_sandbox or
                any(not isinstance(x, str) or not x or '\0' in x for x in fixture_sandbox) or
                fixture_sandbox[0] != '/usr/bin/bwrap'):
                raise ValueError('invalid synthetic sandbox')
        self._fixture_sandbox = tuple(fixture_sandbox or ())
        self._broker_fd, self._ipc_fd = broker_fd, ipc_fd
        self._command, self._uid, self._gid, self._ttl = tuple(command), uid, gid, ttl
        self._lock = threading.Lock()
        self._closed = False
        self._process = None
        self._socket = None
        self._timer = None
        self._lifeline = None

    @property
    def pid(self):
        return self._process.pid if self._process else None

    def start(self):
        with self._lock:
            if self._closed or self._process is not None:
                raise RuntimeError('session already started or closed')
            if os.geteuid() != 0:
                raise PermissionError('root required for namespace and privilege drop')
            host = child = None
            if self._broker_fd is None:
                host, child = socket.socketpair()
            try:
                # The caller owns delegated descriptors and closes its copies after start.
                sources = (child.fileno(),) if child else (self._broker_fd, self._ipc_fd)
                read_fd, self._lifeline = os.pipe2(os.O_CLOEXEC)
                try:
                    argv = ['/usr/bin/unshare','--net','--pid','--fork','--kill-child=KILL',
                            '--','/usr/bin/python3','-c',_INIT,str(read_fd),*self._fixture_sandbox,'/usr/bin/setpriv',
                            '--reuid='+str(self._uid), '--regid='+str(self._gid),
                            '--clear-groups', '--no-new-privs', '/usr/bin/python3',
                            '-c', _WRAPPER, str(len(sources)), *(str(fd) for fd in sources), *self._command]
                    self._process = subprocess.Popen(argv, pass_fds=(*sources, read_fd),
                        start_new_session=True, stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=None,
                        env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','LANG':'C.UTF-8',
                             **self._worker_env, 'SESSION_SOURCE_FDS':','.join(map(str,sources))})
                finally:
                    os.close(read_fd)
                self._socket = host
                self._timer = threading.Timer(self._ttl, self.close)
                self._timer.daemon = True
                self._timer.start()
                if host: threading.Thread(target=self._deny, daemon=True).start()
                threading.Thread(target=self._watch, daemon=True).start()
            except BaseException:
                if host: host.close()
                if self._lifeline is not None:
                    os.close(self._lifeline)
                    self._lifeline = None
                if self._process:
                    self._process.wait()
                raise
            finally:
                if child: child.close()
        return self

    def _deny(self):
        s = self._socket
        try:
            s.settimeout(self._ttl)
            data = bytearray()
            while len(data) < 16384 and b'\r\n\r\n' not in data:
                chunk = s.recv(min(4096, 16384-len(data)))
                if not chunk: return
                data.extend(chunk)
            if b'\r\n\r\n' in data:
                s.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n')
        except OSError:
            pass
        finally:
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            s.close()

    def _watch(self):
        self._process.wait()
        self.close()

    def terminate(self):
        with self._lock:
            if self._lifeline is not None:
                try: os.write(self._lifeline, b'T')
                except BrokenPipeError: pass

    def close(self):
        with self._lock:
            if self._closed: return
            self._closed = True
            if self._timer: self._timer.cancel()
            if self._socket:
                try: self._socket.shutdown(socket.SHUT_RDWR)
                except OSError: pass
                self._socket.close()
            process = self._process
            if self._lifeline is not None:
                os.close(self._lifeline)
                self._lifeline = None
            if process:
                process.wait()


def synthetic_entry():
    # A fixed fixture entry, not a general-purpose privileged launcher.
    if len(sys.argv) != 4 or sys.argv[1] != '--synthetic-fixture' or os.environ.get('NODE_TEST_CONTEXT') != 'synthetic-isolated-web':
        raise SystemExit('synthetic fixture only')
    session_dir, chrome = sys.argv[2:]
    worker = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'test', 'douyin-inherited-headed-worker.js')
    app = os.path.dirname(os.path.dirname(__file__))
    work = os.path.dirname(app)
    if not (session_dir.startswith(work + '/sessions/session-') and chrome == work + '/chrome/chrome'):
        raise SystemExit('invalid synthetic paths')
    from synthetic_uid_ledger import allocate_fixture_uid
    ledger = '/run/douyin-synthetic-uid-ledger'
    os.makedirs(ledger, mode=0o700, exist_ok=True)
    uid = allocate_fixture_uid(ledger, 62000, 62999)
    # This range must be exclusively reserved by the operator; the fixture
    # rejects already-running principals but cannot reserve a host UID range.
    for name in os.listdir('/proc'):
        if name.isdigit():
            try:
                if os.stat('/proc/' + name).st_uid == uid:
                    raise RuntimeError('synthetic fixture UID already active')
            except FileNotFoundError:
                pass
    os.chown(session_dir, uid, uid)
    # Openbox requires getpwuid() for the dropped synthetic principal.  Use a
    # fixture-only passwd database; never expose the host identity database.
    passwd = os.path.join(session_dir, 'fixture-passwd')
    with open(passwd, 'w', encoding='ascii') as f:
        f.write(f'fixture:x:{uid}:{uid}:fixture:/tmp:/bin/false\n')
    os.chmod(passwd, 0o644)
    sandbox = ['/usr/bin/bwrap', '--die-with-parent', '--unshare-ipc',
        '--ro-bind','/usr/lib64','/usr/lib64', '--symlink','usr/lib64','/lib64',
        '--ro-bind','/etc/fonts','/etc/fonts', '--ro-bind',passwd,'/etc/passwd',
        '--ro-bind','/usr/lib','/usr/lib', '--ro-bind','/usr/share','/usr/share',
        '--ro-bind','/usr/bin','/usr/bin', '--symlink','usr/bin','/bin',
        '--ro-bind',app,app, '--ro-bind',os.path.dirname(chrome),os.path.dirname(chrome),
        '--bind',session_dir,session_dir,
        '--proc','/proc','--dev','/dev','--tmpfs','/dev/shm','--chmod','1777','/dev/shm','--tmpfs','/tmp','--chmod','1777','/tmp',
        '--dir','/tmp/.X11-unix','--chmod','1777','/tmp/.X11-unix',
        '--tmpfs','/var/lib/xkb','--chmod','1777','/var/lib/xkb',
        '--chmod','755','/var','--chmod','755','/var/lib',
        '--chmod','755','/','--chmod','755','/usr','--chmod','755','/etc', '--chmod','755','/run',
        '--chmod','755',work, '--chmod','711',os.path.dirname(session_dir), '--']
    worker_env = {'NODE_CHANNEL_FD':'4', 'NODE_CHANNEL_SERIALIZATION_MODE':'json',
                  'NODE_TEST_CONTEXT':'synthetic-isolated-web', 'HOME':'/tmp', 'TMPDIR':'/tmp',
                  'DOUYIN_LOGIN_SESSION_DIR':session_dir}
    session = IsolatedSession(['/usr/bin/node', worker, session_dir, chrome], uid=uid, gid=uid,
                              ttl=90, broker_fd=3, ipc_fd=4, worker_env=worker_env, fixture_sandbox=sandbox)
    def cancel(*_):
        threading.Thread(target=session.terminate, daemon=True).start()
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        session.start()
        os.close(3); os.close(4)
        rc = session._process.wait()
        return rc if rc >= 0 else 128-rc
    finally:
        session.close()

if __name__ == '__main__':
    sys.exit(synthetic_entry())

