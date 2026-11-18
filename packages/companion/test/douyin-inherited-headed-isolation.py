#!/usr/bin/env python3
"""Offline headed browser + inherited FD + separate UID/netns regression.
Run inside a disposable outer network namespace as root; never uses real accounts.
"""
import json, os, shutil, socket, struct, subprocess, sys, tempfile, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CHROME='/root/.cache/ms-playwright/chromium-1217/chrome-linux64'
MODULES=ROOT.parents[1]/'node_modules'

def wait(f, timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            x=f()
            if x: return x
        except (OSError,ValueError): pass
        time.sleep(.1)
    raise TimeoutError('fixture state timeout')

def receive(s,n):
    b=b''
    while len(b)<n:
        x=s.recv(n-len(b))
        if not x: raise EOFError('RFB closed')
        b+=x
    return b

def run(cancel=False):
    assert os.geteuid()==0
    work=Path(tempfile.mkdtemp(prefix='douyin-headed-fd-',dir='/run'))
    broker=browser=None; rfb=None
    try:
        subprocess.run(['ip','link','set','lo','up'],check=True)
        subprocess.run(['ip','addr','add','8.8.8.8/32','dev','lo'],check=True)
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(work/'key'),'-out',str(work/'cert'),'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        app=work/'app'; app.mkdir(); shutil.copytree(ROOT/'src',app/'src'); shutil.copytree(ROOT/'test',app/'test'); shutil.copy2(ROOT/'package.json',app/'package.json'); (app/'node_modules').mkdir(); shutil.copytree(MODULES/'playwright-core',app/'node_modules/playwright-core'); shutil.copytree(CHROME,work/'chrome')
        os.chmod(work,0o755); session=work/'session'; session.mkdir(); os.chown(session,65534,65534); os.chmod(session,0o700)
        a,b=socket.socketpair(); env=os.environ.copy(); env['NODE_TEST_CONTEXT']='child-v8'
        broker=subprocess.Popen(['node',str(ROOT/'test/douyin-inherited-broker-fixture.js'),'headedbroker',str(work),str(a.fileno())],pass_fds=(a.fileno(),),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True); a.close(); assert broker.stdout.readline().strip()=='READY'
        def fd3():
            if b.fileno()!=3: os.dup2(b.fileno(),3,inheritable=True)
            else: os.set_inheritable(3,True)
        env.update(HOME='/tmp',TMPDIR='/tmp')
        browser=subprocess.Popen(['unshare','-n','--','setpriv','--reuid=65534','--regid=65534','--clear-groups','node',str(app/'test/douyin-inherited-headed-worker.js'),str(session),str(work/'chrome/chrome')],close_fds=False,preexec_fn=fd3,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env); b.close()
        info=wait(lambda:json.loads((session/'display.json').read_text()))
        status=lambda:json.loads((session/'status.json').read_text())['status']
        wait(lambda:status()=='waiting_modal')
        rfb=socket.socket(socket.AF_UNIX); rfb.settimeout(10); rfb.connect(info['socket']); rfb.sendall((info['token']+'\n').encode()); assert receive(rfb,12).startswith(b'RFB'); rfb.sendall(b'RFB 003.008\n'); n=receive(rfb,1)[0]; assert 1 in receive(rfb,n); rfb.sendall(b'\x01'); assert receive(rfb,4)==b'\0'*4; rfb.sendall(b'\x01'); init=receive(rfb,24); receive(rfb,struct.unpack('>I',init[20:24])[0])
        def click():
            for buttons in (0,1,0): rfb.sendall(struct.pack('>BBHH',5,buttons,500,400)); time.sleep(.15)
        time.sleep(1); click(); wait(lambda:status()=='need_sms'); assert not (session/'cookies.json').exists()
        if cancel:
            browser.terminate()
        else:
            click(); wait(lambda:status()=='success'); assert any(c['name']=='sessionid' for c in json.loads((session/'cookies.json').read_text()))
        out,err=browser.communicate(timeout=15); assert browser.returncode==0,(out,err)
        assert not Path(info['socket']).exists()
        if cancel: assert not (session/'cookies.json').exists()
        print('PASS: low-UID isolated headed Chromium, inherited broker FD, trusted RFB challenge and '+('cancel' if cancel else 'synthetic login')+'; display socket removed')
    finally:
        if rfb: rfb.close()
        if browser and browser.poll() is None: browser.kill(); browser.wait()
        if broker and broker.poll() is None: broker.terminate(); broker.wait(timeout=10)
        shutil.rmtree(work)
if __name__=='__main__': run('--cancel' in sys.argv)
