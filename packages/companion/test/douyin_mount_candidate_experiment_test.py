#!/usr/bin/env python3
"""Offline mount/net/PID namespace experiment, never an official-site launcher.

Run only as root on a disposable test host. UIDs are synthetic fixture values,
not a production allocator; the fixture intentionally has no broker or IPC.
"""
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest

CHROME = '/root/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64'
BWRAP = '/usr/bin/bwrap'
UIDS = (61101, 61102)
WORKER = r'''import os, socket, subprocess, sys, time
assert os.getuid() == int(sys.argv[1]) and os.getgid() == int(sys.argv[1])
assert not os.path.exists(sys.argv[2]), 'host sentinel visible'
s=socket.socket(); s.settimeout(2)
try:
 s.connect(('127.0.0.1', int(sys.argv[3])))
 raise AssertionError('host loopback reachable')
except (ConnectionRefusedError, OSError): pass
finally: s.close()
p=subprocess.run(['/chrome/chrome-headless-shell','--headless','--no-sandbox','--disable-gpu',
 '--disable-dev-shm-usage','--no-zygote','--user-data-dir=/tmp/profile',
 '--dump-dom','data:text/html,<title>fixture-isolated</title><p>render-ok</p>'],
 capture_output=True,text=True,timeout=60)
assert p.returncode == 0 and '<p>render-ok</p>' in p.stdout, (p.returncode,p.stderr[-2000:])
print('OK uid=%s chromium=rendered sentinel=absent loopback=denied' % os.getuid(), flush=True)
if sys.argv[4] == 'hold':
 subprocess.Popen(['/usr/bin/python3','-c','import os,time; os.setsid(); time.sleep(120)'])
 print('HOLD',flush=True)
 time.sleep(120)
'''

class MountCandidate(unittest.TestCase):
 def test_real_boundary_and_reaping(self):
  if os.geteuid() != 0 or not os.path.exists(CHROME + '/chrome-headless-shell'):
   self.skipTest('root and synthetic Chromium fixture required')
  # Ensure these principals are not in use: no UID allocation claim is made.
  for d in pathlib.Path('/proc').iterdir():
   if d.name.isdigit():
    try:
     if d.stat().st_uid in UIDS: self.fail('fixture uid already active')
    except FileNotFoundError: pass
  with tempfile.TemporaryDirectory(prefix='mount-candidate-', dir='/run') as root:
   os.chmod(root, 0o755)
   sentinel = root + '/same-uid-sentinel'
   pathlib.Path(sentinel).write_text('synthetic')
   os.chown(sentinel, UIDS[0], UIDS[0]); os.chmod(sentinel, 0o600)
   # Prove the negative control: that same UID can read the host file.
   host = subprocess.run(['/usr/bin/setpriv', '--reuid='+str(UIDS[0]), '--regid='+str(UIDS[0]), '--clear-groups', '/usr/bin/python3','-c', 'import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_text()=="synthetic"',sentinel])
   self.assertEqual(host.returncode, 0)
   worker = root + '/worker.py'; pathlib.Path(worker).write_text(WORKER); os.chmod(worker, 0o644)
   server=socket.socket(); server.bind(('127.0.0.1',0)); server.listen(); port=server.getsockname()[1]
   # A real listener exists and is reachable from the host, not merely an unused port.
   with socket.create_connection(('127.0.0.1',port),timeout=2) as client:
    accepted,_=server.accept(); accepted.close()
   def launch(uid, mode):
    args=[BWRAP,'--unshare-pid','--unshare-net','--unshare-ipc','--die-with-parent',
      '--ro-bind','/usr/lib64','/usr/lib64','--symlink','usr/lib64','/lib64',
      '--ro-bind','/usr/bin/python3.11','/usr/bin/python3.11','--symlink','python3.11','/usr/bin/python3',
      '--ro-bind','/usr/bin/setpriv','/usr/bin/setpriv','--ro-bind','/usr/sbin/ip','/usr/sbin/ip','--chmod','755','/usr/sbin','--ro-bind',CHROME,'/chrome',
      '--ro-bind',worker,'/worker.py','--proc','/proc','--dev','/dev',
      '--tmpfs','/tmp','--chmod','1777','/tmp','--chmod','755','/','--chmod','755','/usr','--chmod','755','/usr/bin','--clearenv',
      '--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','PATH','/usr/bin','--setenv','LANG','C.UTF-8',
      '--','/usr/bin/python3','-c',"import os,subprocess,sys; subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True); os.execv(sys.argv[1],sys.argv[1:])",'/usr/bin/setpriv','--reuid='+str(uid),'--regid='+str(uid),'--clear-groups','--no-new-privs',
      '/usr/bin/python3','/worker.py',str(uid),sentinel,str(port),mode]
    return subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
   try:
    first=launch(UIDS[0],'hold'); second=launch(UIDS[1],'once')
    out, err=second.communicate(timeout=50)
    self.assertEqual(second.returncode,0,err); self.assertIn('chromium=rendered',out)
    line=first.stdout.readline(); self.assertIn('chromium=rendered',line,first.stderr.read() if first.poll() is not None else line)
    self.assertEqual(first.stdout.readline().strip(),'HOLD')
    # Kill sandbox supervisor; namespace init death must reap detached descendants.
    os.kill(first.pid,signal.SIGKILL); first.communicate(timeout=15)
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
     active=[]
     for d in pathlib.Path('/proc').iterdir():
      if d.name.isdigit():
       try:
        if d.stat().st_uid in UIDS:
         status=(d/'stat').read_text().split(') ')[1].split()[0]
         if status != 'Z': active.append(d.name)
       except (FileNotFoundError,ProcessLookupError): pass
     if not active: break
     time.sleep(.1)
    self.assertEqual(active, [], 'live fixture processes survived sandbox death')
    self.assertTrue(os.path.exists(sentinel))
    print(line.strip(),out.strip(),'detached-descendants=reaped',flush=True)
   finally:
    server.close()
    for p in (locals().get('first'),locals().get('second')):
     if p and p.poll() is None:
      p.kill(); p.communicate(timeout=10)

if __name__ == '__main__': unittest.main()
