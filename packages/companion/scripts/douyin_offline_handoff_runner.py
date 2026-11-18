#!/usr/bin/env python3
"""Run the existing synthetic handoff fixture, never a real-site login.

Requires a disposable root-capable Linux host with 62000-62999 exclusively
reserved for this fixture across all identity allocators. The UID ledger in
/run/douyin-synthetic-uid-ledger permanently burns IDs until reboot; do not
reuse the range after ledger loss. This is not a production identity allocator.
"""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import shutil

ROOT = Path(__file__).resolve().parents[1]
MODES = ('login', 'cancel', 'disconnect', 'timeout', 'crash', 'refresh', 'digits')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reserved-fixture-uid-range', action='store_true',
                        help='confirm exclusive reservation of host UID/GID 62000-62999')
    parser.add_argument('modes', nargs='*', choices=MODES, default=['login'])
    args = parser.parse_args()
    if not args.reserved_fixture_uid_range:
        parser.error('exclusive reservation of fixture UID/GID range must be confirmed')
    if os.geteuid() != 0:
        parser.error('root is required for Linux namespace and UID isolation')
    fixture = ROOT / 'test' / 'douyin-isolated-web-bridge.py'
    for mode in args.modes:
        # A private PID namespace provides a kernel-enforced kill boundary even
        # when a test times out or its detached supervisor stops responding.
        cmd = ['/usr/bin/unshare', '--mount', '--net', '--pid', '--fork',
               '--mount-proc', '--kill-child=KILL', '--propagation', 'private',
               '/usr/bin/python3', str(fixture), mode]
        # Own the parent outside the child so timeout cleanup also removes a
        # workspace when its namespace is killed before its finally block runs.
        parent = tempfile.mkdtemp(prefix='douyin-handoff-runner-', dir='/run')
        os.chmod(parent, 0o711)  # sandbox must traverse to its explicitly bound files
        try:
            env = {**os.environ, 'DOUYIN_FIXTURE_PARENT': parent}
            proc = subprocess.Popen(cmd, start_new_session=True, env=env)
            try:
                rc = proc.wait(timeout=110)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                raise
            if rc:
                raise SystemExit(f'{mode}: fixture failed ({rc}); remaining modes not run')
        finally:
            shutil.rmtree(parent)
    return 0


if __name__ == '__main__':
    sys.exit(main())
