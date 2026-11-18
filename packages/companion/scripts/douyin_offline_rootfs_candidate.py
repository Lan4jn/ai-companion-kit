#!/usr/bin/python3
"""Offline-only rootfs/lifecycle probe, NOT a production login factory.

Requires root, Linux namespaces, and a disposable machine with UID/GID 61101
reserved exclusively for this probe. No broker, credentials or public network.
The fixed ID and host-library binds are not suitable for production deployment.
"""
import os
import pathlib
import signal
import socket
import subprocess
import tempfile
import time

UID = 61101
WORKER = r'''import os,socket,subprocess,sys,time
assert os.getuid()==61101 and os.getgid()==61101
assert not os.path.exists(sys.argv[1])
s=socket.socket(); s.settimeout(2)
try:
 s.connect(('127.0.0.1',int(sys.argv[2])))
except (ConnectionRefusedError, TimeoutError, OSError): pass
else: raise RuntimeError('host loopback reachable')
finally: s.close()
p=subprocess.Popen(['/usr/bin/python3','-c','import os,time; os.setsid(); time.sleep(120)'])
print('READY',flush=True)
time.sleep(120)
'''

def _active():
    found=[]
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            if p.stat().st_uid == UID and (p/'stat').read_text().split(') ',1)[1].split()[0] != 'Z': found.append(p.name)
        except FileNotFoundError: pass
    return found

def run_synthetic_probe():
    if os.geteuid()!=0: raise PermissionError('root required')
    if _active(): raise RuntimeError('fixture principal already active')
    with tempfile.TemporaryDirectory(prefix='douyin-offline-rootfs-',dir='/run') as root:
        os.chmod(root,0o755)
        sentinel=root+'/synthetic-sentinel'; pathlib.Path(sentinel).write_text('fixture'); os.chown(sentinel,UID,UID); os.chmod(sentinel,0o600)
        worker=root+'/worker.py'; pathlib.Path(worker).write_text(WORKER); os.chmod(worker,0o644)
        control=subprocess.run(['/usr/bin/setpriv',f'--reuid={UID}',f'--regid={UID}','--clear-groups','/usr/bin/python3','-c','import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_text()=="fixture"',sentinel],timeout=10)
        if control.returncode: raise RuntimeError('sentinel positive control failed')
        server=socket.socket(); server.bind(('127.0.0.1',0)); server.listen(); port=server.getsockname()[1]
        with socket.create_connection(('127.0.0.1',port),timeout=2):
            c,_=server.accept(); c.close()
        args=['/usr/bin/bwrap','--unshare-pid','--unshare-net','--unshare-ipc','--die-with-parent',
         '--ro-bind','/usr/lib64','/usr/lib64','--symlink','usr/lib64','/lib64',
         '--ro-bind','/usr/bin/python3.11','/usr/bin/python3.11','--symlink','python3.11','/usr/bin/python3',
         '--ro-bind','/usr/bin/setpriv','/usr/bin/setpriv','--ro-bind',worker,'/worker.py',
         '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chmod','1777','/tmp',
         '--chmod','755','/','--chmod','755','/usr','--chmod','755','/usr/bin','--clearenv',
         '--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C.UTF-8',
         '--','/usr/bin/setpriv',f'--reuid={UID}',f'--regid={UID}','--clear-groups','--no-new-privs',
         '/usr/bin/python3','/worker.py',sentinel,str(port)]
        p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        try:
            import select
            if p.stdout is None: raise RuntimeError('sandbox pipe unavailable')
            if not select.select([p.stdout],[],[],15)[0] or p.stdout.readline().strip()!='READY':
                raise RuntimeError('sandbox did not become ready')
            p.kill(); p.communicate(timeout=10)
            deadline=time.monotonic()+10
            while _active() and time.monotonic()<deadline: time.sleep(.05)
            if _active(): raise RuntimeError('fixture descendants survived')
            if not os.path.exists(sentinel): raise RuntimeError('sentinel changed')
            return {'sentinel_hidden':True,'host_loopback_denied':True,'distinct_uid':True,'detached_reaped':True}
        finally:
            if p.poll() is None: p.kill(); p.communicate(timeout=10)
            server.close()

if __name__=='__main__':
    print(run_synthetic_probe())
