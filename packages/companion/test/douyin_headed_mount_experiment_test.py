#!/usr/bin/env python3
"""Disposable headed rootfs probe; not a secure UID allocator or production launcher."""
import os, pathlib, signal, socket, subprocess, tempfile, time, unittest

CHROME='/root/.cache/ms-playwright/chromium-1217/chrome-linux64'
UID=61103
WORKER=r'''import json, os, pathlib, socket, subprocess, sys, time, urllib.request
assert os.getuid()==int(sys.argv[1])
assert not os.path.exists(sys.argv[2]), 'host sentinel exposed'
s=socket.socket(); s.settimeout(2)
try:
 s.connect(('127.0.0.1',int(sys.argv[3])))
 raise AssertionError('host listener reachable')
except OSError: pass
finally: s.close()
x=subprocess.Popen(['/usr/bin/Xvnc',':91','-rfbport','-1','-rfbunixpath','/tmp/rfb.sock','-rfbunixmode','0600','-SecurityTypes','None','-nolisten','tcp','-geometry','1024x768','-depth','24'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
try:
 for _ in range(100):
  if os.path.exists('/tmp/.X11-unix/X91'): break
  if x.poll() is not None: raise RuntimeError('Xvnc exited: '+x.stderr.read().decode(errors='replace'))
  time.sleep(.1)
 else: raise RuntimeError('Xvnc startup timeout')
 env=dict(os.environ,DISPLAY=':91')
 c=subprocess.Popen(['/chrome/chrome','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=9222','--user-data-dir=/tmp/profile','data:text/html,<title>headed-fixture-ready</title><h1>synthetic</h1>'],env=env,stdout=subprocess.DEVNULL,stderr=open('/tmp/chrome.log','w'))
 try:
  for _ in range(200):
   if c.poll() is not None: raise RuntimeError('Chromium exited: '+pathlib.Path('/tmp/chrome.log').read_text()[-3000:])
   try:
    data=json.load(urllib.request.urlopen('http://127.0.0.1:9222/json',timeout=1))
    if any(p.get('title')=='headed-fixture-ready' for p in data): break
   except (OSError,ValueError): pass
   time.sleep(.1)
  else: raise RuntimeError('headed Chromium did not render fixture')
  r=socket.socket(socket.AF_UNIX); r.settimeout(3); r.connect('/tmp/rfb.sock'); assert r.recv(12).startswith(b'RFB'); r.close()
  subprocess.Popen(['/usr/bin/python3','-c','import os,time; os.setsid(); time.sleep(120)'])
  print('PASS headed-chromium synthetic-render Xvnc-RFB host-file-hidden host-loopback-denied',flush=True)
  time.sleep(120)
 finally:
  c.terminate()
finally:
 x.terminate()
'''

class HeadedMountExperiment(unittest.TestCase):
 def test_headed_rootfs_boundary(self):
  if os.geteuid()!=0 or not pathlib.Path(CHROME+'/chrome').exists(): self.skipTest('root and chromium required')
  for p in pathlib.Path('/proc').iterdir():
   if p.name.isdigit():
    try: self.assertNotEqual(p.stat().st_uid,UID,'fixture UID already active')
    except FileNotFoundError: pass
  with tempfile.TemporaryDirectory(prefix='headed-mount-',dir='/run') as d:
   os.chmod(d,0o755)
   sentinel=d+'/sentinel'; pathlib.Path(sentinel).write_text('fixture'); os.chown(sentinel,UID,UID); os.chmod(sentinel,0o600)
   check=subprocess.run(['/usr/bin/setpriv','--reuid='+str(UID),'--regid='+str(UID),'--clear-groups','/usr/bin/python3','-c','import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_text()=="fixture"',sentinel])
   self.assertEqual(check.returncode,0)
   worker=d+'/worker.py'; pathlib.Path(worker).write_text(WORKER)
   server=socket.socket(); server.bind(('127.0.0.1',0)); server.listen(); port=server.getsockname()[1]
   with socket.create_connection(('127.0.0.1',port),timeout=2):
    connection,_=server.accept(); connection.close()
   args=['/usr/bin/bwrap','--unshare-pid','--unshare-net','--unshare-ipc','--die-with-parent',
    '--ro-bind','/usr/lib64','/usr/lib64','--symlink','usr/lib64','/lib64',
    '--ro-bind','/usr/bin/python3.11','/usr/bin/python3.11','--symlink','python3.11','/usr/bin/python3',
    '--ro-bind','/usr/bin/setpriv','/usr/bin/setpriv','--ro-bind','/usr/bin/sh','/usr/bin/sh','--symlink','usr/bin','/bin','--ro-bind','/usr/sbin/ip','/usr/sbin/ip','--chmod','755','/usr/sbin',
    '--ro-bind','/usr/bin/Xvnc','/usr/bin/Xvnc','--ro-bind','/usr/bin/xkbcomp','/usr/bin/xkbcomp','--ro-bind','/usr/share/X11/xkb','/usr/share/X11/xkb','--ro-bind',CHROME,'/chrome','--ro-bind',worker,'/worker.py',
    '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chmod','1777','/tmp','--dir','/tmp/.X11-unix','--chmod','1777','/tmp/.X11-unix','--tmpfs','/var/lib/xkb','--chmod','1777','/var/lib/xkb','--chmod','755','/var','--chmod','755','/var/lib','--chmod','755','/usr/share','--chmod','755','/usr/share/X11','--chmod','755','/','--chmod','755','/usr','--chmod','755','/usr/bin',
    '--clearenv','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','PATH','/usr/bin','--setenv','LANG','C.UTF-8',
    '--','/usr/bin/python3','-c',"import os,subprocess,sys; subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True); os.execv(sys.argv[1],sys.argv[1:])",'/usr/bin/setpriv','--reuid='+str(UID),'--regid='+str(UID),'--clear-groups','--no-new-privs','/usr/bin/python3','/worker.py',str(UID),sentinel,str(port)]
   p=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
   try:
    import select
    readable,_,_=select.select([p.stdout],[],[],35)
    if not readable: self.fail('sandbox did not report readiness within 35s')
    line=p.stdout.readline()
    if not line: self.fail('sandbox exited: '+p.stderr.read())
    self.assertIn('PASS headed-chromium',line); print(line.strip(),flush=True)
    os.kill(p.pid,signal.SIGKILL); p.communicate(timeout=15)
    deadline=time.monotonic()+10; active=[]
    while time.monotonic()<deadline:
     active=[]
     for q in pathlib.Path('/proc').iterdir():
      if q.name.isdigit():
       try:
        if q.stat().st_uid==UID and (q/'stat').read_text().split(') ')[1].split()[0]!='Z': active.append(q.name)
       except (FileNotFoundError,ProcessLookupError): pass
     if not active: break
     time.sleep(.1)
    self.assertEqual(active,[],'live descendants survived sandbox death')
    self.assertTrue(pathlib.Path(sentinel).exists()); print('PASS abrupt-supervisor-death detached-descendants-reaped',flush=True)
   finally:
    server.close()
    if p.poll() is None: p.kill(); p.communicate(timeout=15)

if __name__=='__main__': unittest.main()
