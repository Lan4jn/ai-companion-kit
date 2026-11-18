import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {mkdirSync, lstatSync, openSync, closeSync, constants} from 'node:fs';
import {spawn} from 'node:child_process';

// All participants must use the same private directory, scope and source.
// Lock files are permanent: unlinking one can split the lock into two inodes.
const keyFor = (directory, scope, source) => JSON.stringify([
  resolve(directory), ...['tenant','platform','type','session','user'].map(k => scope[k]), source,
]);
const timeoutError = () => Object.assign(new Error('forget lock timeout'), {code:'FORGET_LOCK_TIMEOUT'});
const helper = `import fcntl, os, time, sys\nend=time.monotonic()+2\nwhile True:\n try:\n  fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\n  break\n except BlockingIOError:\n  if time.monotonic() >= end: sys.exit(75)\n  time.sleep(.02)\n`;

async function acquire(directory, scope, source) {
  // Parent and helper share one open file description. After flock succeeds,
  // the parent retains the fd; its close or process death releases the lock.
  mkdirSync(directory, {recursive:true, mode:0o700});
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) throw Error('unsafe forget lock directory');
  const file = join(directory, `.forget-lock-${createHash('sha256').update(keyFor(directory, scope, source)).digest('hex')}`);
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) throw Error('unsafe forget lock file');
    await new Promise((resolvePromise, reject) => {
      const child = spawn('/usr/bin/python3', ['-c', helper], {stdio:['ignore','ignore','ignore',fd]});
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolvePromise() : reject(code === 75 ? timeoutError() : Error('forget lock unavailable')));
    });
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

const tails = new Map();
function enqueue(key, action) {
  const previous = tails.get(key) || Promise.resolve();
  let expired = false;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(timeoutError()); }, 2000); });
  const next = previous.then(() => {
    if (expired) return;
    clearTimeout(timer);
    return action();
  });
  const tail = next.then(() => {}, () => {});
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return Promise.race([next, timeout]).finally(() => clearTimeout(timer));
}
export function withForgetWrite(directory, scope, source, write) {
  return enqueue(keyFor(directory, scope, source), async () => {
    const fd = await acquire(directory, scope, source);
    try { return await write(); } finally { closeSync(fd); }
  });
}
export async function startScopedSend(directory, scope, source, valid, send) {
  return enqueue(keyFor(directory, scope, source), async () => {
    const fd = await acquire(directory, scope, source);
    try {
      // Calling an async transport does not mean it has handed off bytes yet.
      // Keep the lock until this individual send settles; later chunks recheck.
      return valid() ? await send() : {ok:false, outcome:'permanent', sent:0, error:'FORGET_DURING_DELIVERY'};
    } finally { closeSync(fd); }
  });
}
