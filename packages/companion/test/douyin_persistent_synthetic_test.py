#!/usr/bin/env python3
"""Disposable offline fixed-UID probe; not an account allocator or production launcher."""
import os, pathlib, pwd, grp, socket, subprocess, tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
UID = 61105
CHROME = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64'
PLAYWRIGHT = ROOT.parents[1] / 'node_modules/playwright-core'

if os.geteuid() != 0 or not pathlib.Path(CHROME+'/chrome').exists():
    raise SystemExit('root and local Chromium required')
for lookup in (pwd.getpwuid, grp.getgrgid):
    try: lookup(UID)
    except KeyError: pass
    else: raise SystemExit('fixture UID/GID already allocated')
for p in pathlib.Path('/proc').iterdir():
    if p.name.isdigit():
        try:
            if p.stat().st_uid == UID: raise SystemExit('fixture UID active')
        except FileNotFoundError: pass
with tempfile.TemporaryDirectory(prefix='persistent-fixture-',dir='/run') as d:
    os.chmod(d,0o755)
    sentinel = d+'/sentinel'
    pathlib.Path(sentinel).write_text('synthetic')
    os.chown(sentinel,UID,UID); os.chmod(sentinel,0o600)
    subprocess.run(['/usr/bin/setpriv',f'--reuid={UID}',f'--regid={UID}','--clear-groups','/usr/bin/python3','-c','import pathlib,sys; assert pathlib.Path(sys.argv[1]).read_text()=="synthetic"',sentinel],check=True)
    with socket.socket() as listener:
        listener.bind(('127.0.0.1',0)); listener.listen(); port=listener.getsockname()[1]
        with socket.create_connection(('127.0.0.1',port),timeout=2):
            c,_=listener.accept(); c.close()
        args=['bwrap','--unshare-pid','--unshare-net','--unshare-ipc','--die-with-parent',
          '--ro-bind','/usr/lib64','/usr/lib64','--symlink','usr/lib64','/lib64',
          '--ro-bind','/usr/bin/node','/usr/bin/node','--ro-bind','/usr/bin/setpriv','/usr/bin/setpriv',
          '--ro-bind','/usr/bin/sh','/usr/bin/sh','--symlink','usr/bin','/bin',
          '--ro-bind','/usr/sbin/ip','/usr/sbin/ip','--chmod','755','/usr/sbin',
          '--ro-bind','/usr/bin/Xvnc','/usr/bin/Xvnc','--ro-bind','/usr/bin/xkbcomp','/usr/bin/xkbcomp',
          '--ro-bind','/usr/share/X11/xkb','/usr/share/X11/xkb','--ro-bind',CHROME,'/chrome',
          '--ro-bind',str(PLAYWRIGHT),'/fixture/playwright','--ro-bind',str(ROOT/'test/douyin-persistent-synthetic.cjs'),'/fixture/test.cjs',
          '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chmod','1777','/tmp',
          '--dir','/tmp/.X11-unix','--chmod','1777','/tmp/.X11-unix','--tmpfs','/var/lib/xkb','--chmod','1777','/var/lib/xkb',
          '--chmod','755','/var','--chmod','755','/var/lib','--chmod','755','/usr/share','--chmod','755','/usr/share/X11',
          '--chmod','755','/','--chmod','755','/usr','--chmod','755','/usr/bin','--chmod','755','/fixture',
          '--clearenv','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','PATH','/usr/bin','--setenv','LANG','C.UTF-8',
          '--','/usr/bin/sh','-c','/usr/sbin/ip link set lo up && exec /usr/bin/setpriv --reuid=61105 --regid=61105 --clear-groups --no-new-privs /usr/bin/node /fixture/test.cjs "$1" "$2"','sh',str(port),sentinel]
        subprocess.run(args,check=True,timeout=75)
        assert pathlib.Path(sentinel).read_text()=='synthetic'
        print('PASS fixture mount hides same-UID sentinel; host loopback denied (positive controls checked)',flush=True)
