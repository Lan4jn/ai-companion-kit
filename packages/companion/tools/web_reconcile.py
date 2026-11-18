#!/usr/bin/env python3
"""Offline, operator-attested reconciliation of a single web research claim."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
TOKEN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')

class ReconcileError(Exception):
    pass

def _token(s):
    if not isinstance(s, str) or not TOKEN.fullmatch(s):
        raise ReconcileError('invalid identifier')
    return s

def _normalize(s):
    # Use the exact JS implementation and its Unicode tables, not Python's.
    code = "let s=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(s.normalize('NFKC').toLowerCase().replace(/[\\s\\p{P}\\p{S}]+/gu,'')))"
    p = subprocess.run(['node', '-e', code], input=json.dumps(s), text=True, capture_output=True, timeout=5, check=True)
    return json.loads(p.stdout)

def _load(file):
    file = Path(file).resolve(strict=True)
    st = file.stat()
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise ReconcileError('unsupported store')
    raw = file.read_bytes()
    state = json.loads(raw)
    if state.get('version') != 1 or not all(isinstance(state.get(k), dict) for k in ('goals','desires','events')):
        raise ReconcileError('unsupported store version')
    return file, raw, state

def _target(state, goal_id, desire_id, topic):
    _token(goal_id); _token(desire_id)
    if not isinstance(topic, str): raise ReconcileError('invalid topic')
    key = _normalize(topic)
    if len(key) < 2: raise ReconcileError('invalid topic')
    g = state['goals'].get(goal_id); d = state['desires'].get(desire_id)
    if not isinstance(g, dict) or not isinstance(d, dict): raise ReconcileError('target not found')
    try: meta = json.loads(g['title'])
    except (KeyError, TypeError, ValueError): raise ReconcileError('invalid target') from None
    if not isinstance(meta, dict) or meta.get('kind') != 'web-deep-search' or not isinstance(meta.get('topic'), str) or _normalize(meta['topic']) != key:
        raise ReconcileError('target topic mismatch')
    if g.get('id') != goal_id or d.get('id') != desire_id or d.get('goalId') != goal_id or g.get('target') != 1 or g.get('progress') != 0 or g.get('status') != 'active' or d.get('status') != 'active':
        raise ReconcileError('target not an unresolved claim')
    if sum(isinstance(x, dict) and x.get('goalId') == goal_id and x.get('status') == 'active' for x in state['desires'].values()) != 1:
        raise ReconcileError('ambiguous target')
    return g, d, key

def audit(file, goal_id, desire_id, topic):
    file, raw, state = _load(file)
    _, _, key = _target(state, goal_id, desire_id, topic)
    return {'store': str(file), 'goal_id': goal_id, 'desire_id': desire_id, 'topic_sha256': hashlib.sha256(key.encode()).hexdigest(), 'version': hashlib.sha256(raw).hexdigest(), 'state': 'unknown'}

def resolve(file, goal_id, desire_id, topic, version, outcome, operator, evidence):
    _token(operator); _token(evidence)
    if outcome not in ('completed', 'terminated') or not re.fullmatch(r'[0-9a-f]{64}', version or ''):
        raise ReconcileError('invalid decision')
    # Same canonical path and stable flock inode as goal-core. Never delete the lock.
    file = Path(file).resolve(strict=True)
    fd = os.open(str(file) + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise ReconcileError('store busy; no change') from None
        file, raw, state = _load(file)
        if hashlib.sha256(raw).hexdigest() != version: raise ReconcileError('store changed; re-audit')
        g, d, _ = _target(state, goal_id, desire_id, topic)
        event_id = 'manual-web-reconcile-' + str(uuid.uuid4())
        if event_id in state['events']: raise ReconcileError('event collision')
        if outcome == 'completed':
            g['progress'] = 1; g['status'] = 'completed'; d['status'] = 'completed'
        else:
            g['status'] = 'failed'; d['status'] = 'failed'
        d['outcomeEventId'] = event_id
        state['events'][event_id] = {'id':event_id, 'type':'web.manual-reconciliation', 'goalId':goal_id, 'desireId':desire_id, 'outcome':outcome, 'operator':operator, 'evidenceRef':evidence, 'priorVersion':version}
        payload = json.dumps(state, ensure_ascii=False, indent=2).encode()
        tmp = None
        try:
            tfd, tmp = tempfile.mkstemp(prefix=file.name + '.', suffix='.tmp', dir=file.parent)
            with os.fdopen(tfd, 'wb') as out:
                out.write(payload); out.flush(); os.fsync(out.fileno())
            os.replace(tmp, file); tmp = None
            dirfd = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
            try: os.fsync(dirfd)
            finally: os.close(dirfd)
        finally:
            if tmp is not None:
                try: os.unlink(tmp)
                except FileNotFoundError: pass
        return {'event_id':event_id, 'outcome':outcome}
    finally:
        os.close(fd)

def main():
    p = argparse.ArgumentParser(description='Offline web-claim audit / human reconciliation')
    p.add_argument('action', choices=['audit','resolve'])
    p.add_argument('--store', required=True); p.add_argument('--goal', required=True); p.add_argument('--desire', required=True)
    p.add_argument('--topic', required=True, help='exact topic selection; shell history may retain it')
    p.add_argument('--version'); p.add_argument('--outcome', choices=['completed','terminated']); p.add_argument('--operator'); p.add_argument('--evidence-ref')
    a = p.parse_args()
    # This executable is deliberately limited to the isolated workspace.
    store = Path(a.store).resolve(strict=True)
    if not store.is_relative_to(ROOT): raise ReconcileError('store outside isolated workspace')
    if a.action == 'audit':
        print(json.dumps(audit(store, a.goal, a.desire, a.topic), ensure_ascii=False)); return
    if not all((a.version, a.outcome, a.operator, a.evidence_ref)):
        raise ReconcileError('version, outcome, operator and evidence-ref required')
    with open('/dev/tty', 'r+', encoding='utf8') as tty:
        if not os.isatty(tty.fileno()): raise ReconcileError('interactive terminal required')
        tty.write('Manually verify independent evidence (not a script or simulated receipt), correct identity and that no execution is still running. Unknown must stay unknown.\n')
        tty.write(f'Store={store}\nGoal={a.goal} Desire={a.desire} version={a.version}\nOutcome={a.outcome} operator={a.operator} evidence-ref={a.evidence_ref}\nType exactly: I VERIFIED {a.goal} {a.desire} {a.outcome}\n> '); tty.flush()
        if tty.readline().rstrip('\n') != f'I VERIFIED {a.goal} {a.desire} {a.outcome}': raise ReconcileError('confirmation declined')
    print(json.dumps(resolve(store, a.goal, a.desire, a.topic, a.version, a.outcome, a.operator, a.evidence_ref)))

if __name__ == '__main__':
    try: main()
    except Exception:
        # A write may have happened before an fsync error: never assert failure or retry.
        print('Reconciliation not confirmed; do not retry automatically. Re-audit and independently verify.', file=sys.stderr)
        sys.exit(1)
