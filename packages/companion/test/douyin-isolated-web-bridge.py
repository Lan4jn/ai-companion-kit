#!/usr/bin/env python3
"""Synthetic-only web handoff through inherited broker and isolated worker.
Run in a disposable outer network namespace; never contacts the real platform.
"""
import os, shutil, subprocess, sys, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
CHROME=Path('/root/.cache/ms-playwright/chromium-1217/chrome-linux64')
MODULES=ROOT.parents[1]/'node_modules'

def main():
    if os.geteuid()!=0: raise RuntimeError('root needed for disposable namespaces')
    work=Path(os.environ['DOUYIN_FIXTURE_WORK']) if 'DOUYIN_FIXTURE_WORK' in os.environ else Path(tempfile.mkdtemp(prefix='douyin-web-fd-',dir='/run'))
    broker=None
    try:
        subprocess.run(['ip','link','set','lo','up'],check=True)
        subprocess.run(['ip','addr','add','8.8.8.8/32','dev','lo'],check=True)
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(work/'key'),'-out',str(work/'cert'),'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        app=work/'app'; app.mkdir()
        shutil.copytree(ROOT/'src',app/'src'); shutil.copytree(ROOT/'test',app/'test')
        (app/'scripts').mkdir()
        for name in ('isolated_session_supervisor.py', 'synthetic_uid_ledger.py'):
            shutil.copy2(ROOT/'scripts'/name, app/'scripts'/name)
        shutil.copy2(ROOT/'package.json',app/'package.json'); (app/'node_modules').mkdir()
        shutil.copytree(MODULES/'playwright-core',app/'node_modules/playwright-core')
        shutil.copytree(CHROME,work/'chrome')
        os.chmod(work,0o755); session=work/'session'; session.mkdir(); os.chown(session,65534,65534); os.chmod(session,0o700)
        env={**os.environ,'NODE_TEST_CONTEXT':'synthetic-isolated-web'}
        mode=sys.argv[1] if len(sys.argv)>1 else 'login'
        subprocess.run(['node',str(ROOT/'test/douyin-isolated-web-bridge-fixture.js'),str(work),mode],env=env,check=True,timeout=90)
    finally:
        if broker and broker.poll() is None:
            broker.terminate()
            try: broker.wait(timeout=10)
            except subprocess.TimeoutExpired: broker.kill(); broker.wait()
        if 'DOUYIN_FIXTURE_WORK' not in os.environ:
            shutil.rmtree(work)

if __name__=='__main__': main()
