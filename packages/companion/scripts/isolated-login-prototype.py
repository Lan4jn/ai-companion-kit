#!/usr/bin/env python3
"""Synthetic-only, network-isolated RFB handoff prototype. No account support."""
import os
import pwd
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote
from pathlib import Path
from synthetic_login_handoff import SyntheticHandoff, FIXTURE
from synthetic_rfb_broker import SingleUseBroker

CHROME = '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'


def stop(*_):
    raise SystemExit(0)


def approved_window(tree, marker):
    # Match the whole X11 window title, never a marker embedded in a data URL.
    return bool(re.search(r'^\s*0x[0-9a-f]+ "' + re.escape(marker) + r'(?: - Google Chrome for Testing)?":', tree, re.MULTILINE))


def child(work):
    # Fail closed even if the internal entry point is invoked directly.
    if os.stat('/proc/self/ns/net').st_ino == os.stat(f'/proc/{os.getppid()}/ns/net').st_ino:
        raise SystemExit('Network namespace isolation required')
    if os.geteuid() != 0:
        raise SystemExit('Synthetic launcher requires root to create isolated UID')
    if os.stat('/proc/self/ns/mnt').st_ino == os.stat(f'/proc/{os.getppid()}/ns/mnt').st_ino:
        raise SystemExit('Mount namespace isolation required')
    subprocess.run(['mount', '--make-rprivate', '/'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['mount', '--bind', str(Path(CHROME).parent), '/opt'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    uid = int(os.environ['SYNTHETIC_RUN_UID'])
    passwd = Path(work) / 'passwd'
    passwd.write_text(Path('/etc/passwd').read_text() + f'\nsynthetic-{uid}:x:{uid}:{uid}:Synthetic session:/nonexistent:/sbin/nologin\n')
    os.chown(passwd, uid, uid)
    os.chmod(passwd, 0o644)
    subprocess.run(['mount', '--bind', str(passwd), '/etc/passwd'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['mount', '--bind', work, '/mnt'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chdir('/mnt')
    # Per-run UID is not assigned to a service account; no persistent account is created.
    os.setgroups([])
    os.setgid(uid)
    os.setuid(uid)
    os.environ.update(HOME='/mnt', TMPDIR='/mnt', XDG_RUNTIME_DIR='/mnt', DBUS_SESSION_BUS_ADDRESS='unix:path=/mnt/nonexistent')
    work_path = work
    work = '.'
    processes = []
    broker = None
    signal.signal(signal.SIGTERM, stop)
    auth = str(Path(work) / 'Xauthority')
    Path(auth).touch(mode=0o600)
    readfd, writefd = os.pipe()
    try:
        xvnc = subprocess.Popen(['Xvnc', '-displayfd', str(writefd), '-auth', auth,
            '-rfbport', '-1', '-rfbunixpath', str(Path(work) / 'rfb.sock'),
            '-rfbunixmode', '0600', '-SecurityTypes', 'None', '-nolisten', 'tcp',
            '-geometry', '1024x768', '-depth', '24'], pass_fds=(writefd,),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(xvnc)
        os.close(writefd)
        display = ':' + os.read(readfd, 32).decode().strip()
        os.close(readfd)
        if display == ':' or xvnc.poll() is not None:
            raise RuntimeError('Xvnc could not start')
        subprocess.run(['xauth', '-f', auth, 'add', display, '.', secrets.token_hex(16)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env = {**os.environ, 'DISPLAY': display, 'XAUTHORITY': auth}
        processes.append(subprocess.Popen(['openbox'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        handoff = SyntheticHandoff(work, ttl=int(os.environ.get('SYNTHETIC_HANDOFF_TTL', '60')))
        token = handoff.start()
        marker = 'synthetic-approved-' + secrets.token_hex(24)
        page = 'data:text/html,' + quote('''<style>html,body{margin:0;width:100%;height:100%;background:red}input{position:absolute;left:10px;top:10px}#result{position:absolute;left:0;top:100px;width:40px;height:40px;background:black}</style><input id="synthetic" autocomplete="off"><div id="result"></div><script>const field=document.querySelector('#synthetic'),result=document.querySelector('#result');field.oninput=()=>{const s=field.value;result.style.background=s==='abc'?'rgb(1,2,3)':s==='ab'?'rgb(4,5,6)':s==='ab中文'?'rgb(7,8,9)':s==='ab<img src=x onerror=alert(1)>'?'rgb(10,11,12)':s==='ab中'?'rgb(13,14,15)':s==='ab文'?'rgb(16,17,18)':'black'};onpointerup=e=>{if(e.isTrusted && e.target!==field){document.title="''' + marker + '''";document.body.style.background="lime"}}</script>''')
        processes.append(subprocess.Popen(['/opt/chrome', '--no-sandbox', '--disable-gpu', '--no-first-run',
            '--disable-background-networking', '--disable-extensions', '--kiosk',
            '--user-data-dir=/mnt/profile', page], env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        sock = Path(work) / 'rfb.sock'
        for _ in range(100):
            if all(p.poll() is None for p in processes) and sock.is_socket():
                broker_token = secrets.token_urlsafe(32)
                broker = SingleUseBroker('access.sock', str(sock), broker_token, handoff.deadline)
                broker.start()
                print('SOCKET=' + str(Path(work_path) / 'access.sock'), flush=True)
                print('TOKEN=' + broker_token, flush=True)
                break
            if any(p.poll() is not None for p in processes):
                raise RuntimeError('display or browser failed')
            time.sleep(.1)
        else:
            raise RuntimeError('RFB socket not ready')
        while all(p.poll() is None for p in processes):
            if broker.done.is_set() or time.monotonic() >= handoff.deadline:
                handoff.close()
                return
            if handoff.state == 'waiting':
                tree = subprocess.run(['xwininfo', '-root', '-tree'], env=env,
                    capture_output=True, text=True, timeout=3, check=True).stdout
                if approved_window(tree, marker):
                    # This fixed fixture is the entire synthetic platform check.
                    # X11 and RFB clients are trusted only within this demo.
                    handoff.complete(token, owner_approved=True,
                        platform_verified=True, candidate=FIXTURE)
                    print('SYNTHETIC_FIXTURE_IMPORTED', flush=True)
            time.sleep(.2)
        raise RuntimeError('display or browser exited: ' + str([p.poll() for p in processes]))
    finally:
        if broker: broker.close()
        for p in reversed(processes):
            if p.poll() is None: p.terminate()
        for p in reversed(processes):
            try: p.wait(timeout=3)
            except subprocess.TimeoutExpired: p.kill(); p.wait()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == '--child':
        return child(sys.argv[2])
    if len(sys.argv) != 1:
        raise SystemExit('Synthetic-only prototype accepts no options')
    signal.signal(signal.SIGTERM, stop)
    if os.geteuid() != 0:
        raise SystemExit('Synthetic launcher requires root to isolate an ephemeral UID')
    scratch = os.environ.get('TMPDIR', '/root/.hermes/cache/scratch')
    work = tempfile.mkdtemp(prefix='login-prototype-', dir=scratch)
    # An unused system account ID, chosen afresh per run. This is not a user namespace;
    # privileged host processes remain trusted and old files with the UID may exist.
    assigned = {p.pw_uid for p in pwd.getpwall()}
    used = set(assigned)
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            try: used.add(entry.stat().st_uid)
            except FileNotFoundError: pass
    uid = next((i for i in (secrets.randbelow(1000000000) + 1000000 for _ in range(100)) if i not in used), None)
    if uid is None:
        shutil.rmtree(work, ignore_errors=True)
        raise SystemExit('Could not allocate a test UID')
    os.chown(work, uid, uid)
    proc = None
    try:
        env = {**os.environ, 'SYNTHETIC_RUN_UID': str(uid)}
        proc = subprocess.Popen(['unshare', '--mount', '--net', sys.executable, __file__, '--child', work], start_new_session=True, env=env)
        rc = proc.wait()
        if rc: raise SystemExit('Prototype stopped: isolation or browser startup failed')
    finally:
        if proc and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL); proc.wait()
        shutil.rmtree(work, ignore_errors=True)

if __name__ == '__main__': main()
