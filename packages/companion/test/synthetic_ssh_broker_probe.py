#!/usr/bin/env python3
"""Self-contained SSH + one-shot broker proof; synthetic data only, not a service.

Runs an ephemeral sshd in fresh network/mount namespaces. SSH forwarding and
PTYs are disabled; a forced command can only relay to the fixture broker.
Root is needed for namespace setup. Do not use this as production isolation.
"""
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from synthetic_rfb_broker import SingleUseBroker


def run(args, **kw):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw)


def child():
    for ns in ('net', 'mnt'):
        if os.stat('/proc/self/ns/' + ns).st_ino == os.stat('/proc/%d/ns/%s' % (os.getppid(), ns)).st_ino:
            raise RuntimeError(ns + ' namespace required')
    run(['mount', '--make-rprivate', '/'])
    # sshd requires /run/sshd. Mounting /run only inside the new namespace avoids
    # changing the host, including when this proof is interrupted.
    run(['mount', '-t', 'tmpfs', '-o', 'mode=755,nosuid,nodev,noexec', 'tmpfs', '/run'])
    Path('/run/sshd').mkdir(mode=0o755)
    run(['ip', 'link', 'set', 'lo', 'up'])
    with tempfile.TemporaryDirectory(prefix='synthetic-ssh-', dir=os.environ['TMPDIR']) as tmp:
        d = Path(tmp)
        os.chmod(d, 0o700)
        for name in ('host', 'client', 'invalid'):
            run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(d / name)])
        # A forced command with no user-controlled arguments. The token is a
        # fixed non-secret fixture, never a platform password or OTP.
        proxy = d / 'relay.py'
        proxy.write_text("""import os,select,socket,sys\ns=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.sendall(b'fixture-token\\n')\nwhile True:\n r,_,_=select.select([0,s],[],[])\n if 0 in r:\n  b=os.read(0,65536)\n  if not b: break\n  s.sendall(b)\n if s in r:\n  b=s.recv(65536)\n  if not b: break\n  os.write(1,b)\ns.close()\n""")
        authorized = d / 'authorized_keys'
        authorized.write_text('restrict ' + (d / 'client.pub').read_text())
        upstream = socket.socket(socket.AF_UNIX)
        upstream.bind(str(d / 'up')); upstream.listen(); upstream.settimeout(5)
        broker = SingleUseBroker(str(d / 'access'), str(d / 'up'), 'fixture-token', time.monotonic() + 25)
        broker.start()
        # Binding port 0 is not accepted by sshd. The reservation is safe here:
        # this namespace contains only processes launched by this test.
        s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
        conf = d / 'sshd_config'
        conf.write_text(f'''Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host\nPidFile {d}/sshd.pid\nAuthorizedKeysFile {authorized}\nStrictModes no\nPermitRootLogin prohibit-password\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\nUsePAM no\nAllowUsers root\nAllowTcpForwarding no\nAllowStreamLocalForwarding no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTunnel no\nPermitTTY no\nPermitUserEnvironment no\nPermitUserRC no\nForceCommand /usr/bin/python3 {proxy} {d}/access\nLogLevel ERROR\n''')
        known = d / 'known_hosts'
        known.write_text(f'[127.0.0.1]:{port} ' + (d / 'host.pub').read_text())
        daemon = None
        try:
            run(['/usr/sbin/sshd', '-t', '-f', str(conf)])
            daemon = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(conf)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            for _ in range(100):
                if daemon.poll() is not None: raise RuntimeError('sshd exited: ' + daemon.stderr.read().decode())
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.1): break
                except OSError: time.sleep(.05)
            else: raise RuntimeError('sshd did not listen')
            base = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={known}', '-o', 'ConnectTimeout=3', '-p', str(port)]
            wrong_known = d / 'wrong_known_hosts'
            wrong_known.write_text(f'[127.0.0.1]:{port} ' + (d / 'invalid.pub').read_text())
            # OpenSSH uses the first occurrence of an option, so replace it explicitly.
            wrong_args = [f'UserKnownHostsFile={wrong_known}' if x == f'UserKnownHostsFile={known}' else x for x in base]
            wrong_host = subprocess.run(wrong_args + ['-i', str(d/'client'), 'root@127.0.0.1'], capture_output=True, timeout=6)
            assert wrong_host.returncode != 0 and b'HOST IDENTIFICATION HAS CHANGED' in wrong_host.stderr, 'host key mismatch accepted'
            bad = subprocess.run(base + ['-i', str(d/'invalid'), 'root@127.0.0.1', 'ignored'], capture_output=True, timeout=6)
            assert bad.returncode != 0 and b'Permission denied' in bad.stderr, 'invalid SSH key accepted'
            forward = subprocess.run(base + ['-i', str(d/'client'), '-W', '127.0.0.1:1', 'root@127.0.0.1'], capture_output=True, timeout=6)
            assert forward.returncode != 0 and b'administratively prohibited' in forward.stderr, 'SSH forwarding not blocked'
            # A requested shell command must be ignored in favour of the fixed relay.
            command_marker = d / 'command-ran'
            client = subprocess.Popen(base + ['-i', str(d/'client'), 'root@127.0.0.1', 'touch ' + str(command_marker)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            peer, _ = upstream.accept(); peer.settimeout(3)
            peer.sendall(b'RFB SYNTHETIC\n')
            assert client.stdout.readline() == b'RFB SYNTHETIC\n'
            client.stdin.write(b'fixture-input\n'); client.stdin.flush()
            assert peer.recv(100) == b'fixture-input\n'
            assert not command_marker.exists(), 'arbitrary command executed'
            # Claim is consumed while connection is alive.
            replay = subprocess.run(base + ['-i', str(d/'client'), 'root@127.0.0.1', 'ignored'], capture_output=True, timeout=6)
            assert b'RFB SYNTHETIC' not in replay.stdout and not replay.stdout, 'replay received data'
            upstream.settimeout(.3)
            try:
                extra, _ = upstream.accept()
                extra.close()
                raise AssertionError('replay opened a second upstream')
            except socket.timeout:
                pass
            client.stdin.close(); client.wait(timeout=6); peer.close()
            assert broker.done.wait(3), 'disconnect did not revoke broker'
            broker.join(3)
            assert not (d/'access').exists(), 'broker socket remains'
            print('PASS: pinned host key; invalid key rejected; forwarding blocked; forced command; one claim; replay rejected; disconnect revoked')
        finally:
            broker.close(); upstream.close()
            if daemon:
                daemon.terminate()
                try: daemon.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    daemon.kill(); daemon.wait()


def main():
    if sys.argv[1:] == ['--child']:
        child(); return
    if sys.argv[1:] or os.geteuid() != 0:
        raise SystemExit('Run without options as root in a disposable test environment')
    os.environ.setdefault('TMPDIR', '/root/.hermes/cache/scratch')
    # Every process in this proof is in a disposable namespace and process group.
    p = subprocess.Popen(['unshare', '--mount', '--net', sys.executable, __file__, '--child'], start_new_session=True)
    try:
        rc = p.wait(timeout=50)
    finally:
        try: os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        p.wait()
    if rc: raise SystemExit(rc)


if __name__ == '__main__': main()
