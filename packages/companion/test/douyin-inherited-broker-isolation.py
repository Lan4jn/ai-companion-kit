#!/usr/bin/env python3
"""Disposable, offline cross-UID socketpair/Chromium fixture; requires root + bwrap."""
import os, socket, subprocess, tempfile, shutil, signal, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHROME = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64'
NODE_MODULES = ROOT.parents[1] / 'node_modules'

def run():
    assert os.geteuid() == 0
    work = tempfile.mkdtemp(prefix='douyin-fd-test-', dir='/run')
    broker = browser = None
    try:
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',work+'/key','-out',work+'/cert','-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['ip','link','set','lo','up'],check=True)
        subprocess.run(['ip','addr','add','8.8.8.8/32','dev','lo'],check=True)
        a,b=socket.socketpair()
        env=os.environ.copy(); env['NODE_TEST_CONTEXT']='child-v8'
        broker=subprocess.Popen(['node',str(ROOT/'test/douyin-inherited-broker-fixture.js'),'broker',work,str(a.fileno())],pass_fds=(a.fileno(),),env=env,stdout=subprocess.PIPE,text=True)
        a.close()
        assert broker.stdout.readline().strip() == 'READY'
        # Only fd 3 crosses exec; the original descriptor remains close-on-exec.
        def fd3():
            if b.fileno()!=3: os.dup2(b.fileno(),3,inheritable=True)
            else: os.set_inheritable(3,True)
        os.chmod(work, 0o755)
        app=Path(work)/'app'; app.mkdir()
        shutil.copytree(ROOT/'src',app/'src')
        shutil.copytree(ROOT/'test',app/'test')
        shutil.copy2(ROOT/'package.json',app/'package.json')
        (app/'node_modules').mkdir()
        shutil.copytree(NODE_MODULES/'playwright-core',app/'node_modules/playwright-core')
        shutil.copytree(CHROME,Path(work)/'chrome')
        command=['unshare','-n','--','setpriv','--reuid=65534','--regid=65534','--clear-groups',
                 'node',str(app/'test/douyin-inherited-broker-fixture.js'),'browser',work+'/chrome/chrome']
        env_browser=env.copy(); env_browser.update({'HOME':'/tmp','TMPDIR':'/tmp'})
        browser=subprocess.Popen(command,close_fds=False,preexec_fn=fd3,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env_browser)
        b.close()
        assert browser.stdout.readline().strip() == 'CLIENT_READY'
        # Linux ptrace/proc access must reject an unrelated UID (65533).
        attack=subprocess.run(['setpriv','--reuid=65533','--regid=65533','--clear-groups','node','-e',
          'require("fs").openSync("/proc/"+process.argv[1]+"/fd/3","r+")',str(browser.pid)],capture_output=True,text=True)
        assert attack.returncode != 0 and 'EACCES' in attack.stderr, attack.stderr
        print('PASS: unrelated UID cannot open connector fd')
        browser.stdin.write('go\n'); browser.stdin.flush()
        out,err=browser.communicate(timeout=70)
        print(out,end=''); print(err,end='',file=sys.stderr)
        assert browser.returncode==0, f'browser exited {browser.returncode}'
    finally:
        if browser and browser.poll() is None: browser.kill(); browser.wait()
        if broker and broker.poll() is None:
            broker.terminate()
            try: broker.wait(timeout=5)
            except subprocess.TimeoutExpired: broker.kill(); broker.wait()
        shutil.rmtree(work)

if __name__=='__main__': run()
