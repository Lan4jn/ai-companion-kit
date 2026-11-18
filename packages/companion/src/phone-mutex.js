import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
const lockContext = new AsyncLocalStorage();

// A best-effort guard, not a fencing token: the holder can die immediately
// after this check, or an already-dispatched device command can continue.
export function assertPhoneLock() {
  const lease = lockContext.getStore();
  if (!lease || !lease.active || lease.child.exitCode !== null || lease.child.signalCode !== null) throw new Error('Phone mutex lock lost');
  try {
    const stat = readFileSync(`/proc/${lease.child.pid}/stat`, 'utf8');
    if (/^\d+ \(.*\) [ZX]/.test(stat)) throw new Error('dead');
  } catch { throw new Error('Phone mutex lock lost'); }
}

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Never unlink lock files: flock locks an inode, not its pathname.
const defaultLockPath = process.env.PHONE_MUTEX_PATH || path.join(os.homedir(), '.cache', 'ai-companion', 'phone.lock');
// Only the lock-owning process removes the marker, after an explicit completion
// message. EOF (including owner death) leaves the marker in place.
const holderScript = `
const fs = require('fs');
try {
  const fd = fs.openSync(process.argv[1], 'wx', 0o600);
  try { fs.writeFileSync(fd, 'pid=' + process.pid + '\\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
} catch (e) {
  if (e.code === 'EEXIST') { console.error('Phone mutex unclean; manual recovery required'); process.exit(76); }
  console.error(e.stack || e); process.exit(1);
}
process.stdin.resume(); console.log('locked');
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s => { input += s; });
process.stdin.on('end', () => { if (input === 'done') { try { fs.unlinkSync(process.argv[1]); } catch { process.exitCode = 1; } } });`;

async function acquire(lockPath, background, timeoutMs) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const wait = background ? ['-n'] : ['-w', String(timeoutMs / 1000)];
  // Users hold a shared admission lock while waiting, preventing background
  // from overtaking them. Each flock -F execs, so parent death closes stdin
  // of the sole lock holder and the kernel releases both locks.
  const args = ['-F', '-E', '75', background ? '-x' : '-s', ...wait, lockPath + '.users',
    'flock', '-F', '-E', '75', '-x', ...wait, lockPath,
    process.execPath, '-e', holderScript, lockPath + '.unclean'];
  const child = spawn('flock', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', s => { stderr += s; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const acquired = new Promise(resolve => child.stdout.once('data', () => resolve(true)));
  const outcome = await Promise.race([acquired, exit]);
  if (outcome !== true) {
    if (outcome.code === 75 && background) return null;
    if (outcome.code === 75) throw new Error('Phone mutex acquisition timed out');
    if (outcome.code === 76) throw new Error('Phone mutex unclean; manual recovery required');
    throw new Error(`Phone mutex failed (${outcome.signal || outcome.code}): ${stderr}`);
  }
  // The holder creates and syncs the marker before announcing readiness. If it
  // dies after announcing, the marker remains and no callback should start.
  const lease = { child, active: true };
  try { lockContext.run(lease, assertPhoneLock); }
  catch (err) { lease.active = false; child.stdin.end(); await exit; throw err; }
  const release = async () => {
    lease.active = false;
    child.stdin.end('done');
    const result = await exit;
    if (result.code !== 0) throw new Error('Phone mutex lock lost');
  };
  return { release, lease };
}

export function createPhoneMutex({ lockPath = defaultLockPath, timeoutMs = 30000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid phone mutex timeout');
  let busy = false;
  const queue = [];
  const releaseLocal = () => { const next = queue.shift(); if (next) next(); else busy = false; };
  return {
    async runUser(fn) {
      if (busy) await new Promise(resolve => queue.push(resolve)); else busy = true;
      try {
        const lock = await acquire(lockPath, false, timeoutMs);
        try { return await lockContext.run(lock.lease, fn); } finally { await lock.release(); }
      } finally { releaseLocal(); }
    },
    async tryBackground(fn) {
      if (busy || queue.length) return false;
      busy = true;
      try {
        const lock = await acquire(lockPath, true, timeoutMs);
        if (!lock) return false;
        try { await lockContext.run(lock.lease, fn); return true; } finally { await lock.release(); }
      } finally { releaseLocal(); }
    }
  };
}
export const phoneMutex = createPhoneMutex();
