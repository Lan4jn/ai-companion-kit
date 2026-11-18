import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as locks from '../src/phone-mutex.js';

test('a dead lock holder invalidates the callback before a later device operation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lock-loss-'));
  const lockPath = path.join(dir, 'phone.lock');
  let writes = 0;
  try {
    let error;
    await locks.createPhoneMutex({lockPath}).runUser(async () => {
      const children = execFileSync('pgrep', ['-P', String(process.pid)], {encoding:'utf8'}).trim().split(/\s+/).map(Number);
      const holder = children.find(pid => {
        try { return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {encoding:'utf8'}).includes("process.stdin.resume()"); } catch { return false; }
      });
      assert.ok(holder, 'lock holder exists');
      process.kill(holder, 'SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(typeof locks.assertPhoneLock, 'function', 'lock assertion must exist');
      locks.assertPhoneLock();
      writes++;
    }).catch(e => { error = e; });
    assert.equal(writes, 0);
    assert.equal(error?.message, 'Phone mutex lock lost');
  } finally { await rm(dir, {recursive:true, force:true}); }
});


test('a killed holder cannot let another owner overlap an in-flight operation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lock-inflight-'));
  const lockPath = path.join(dir, 'phone.lock');
  const mutex = locks.createPhoneMutex({lockPath, timeoutMs: 3000});
  let finish, started;
  const startedPromise = new Promise(r => { started = r; });
  const operation = new Promise(r => { finish = r; });
  const first = mutex.runUser(async () => {
    const children = execFileSync('pgrep', ['-P', String(process.pid)], {encoding:'utf8'}).trim().split(/\s+/).map(Number);
    const holder = children.find(pid => {
      try { return execFileSync('ps', ['-p', String(pid), '-o', 'args='], {encoding:'utf8'}).includes('process.stdin.resume()'); } catch { return false; }
    });
    assert.ok(holder);
    process.kill(holder, 'SIGKILL');
    started();
    await operation;
  });
  try {
    await startedPromise;
    await new Promise(r => setTimeout(r, 150));
    let entered = false;
    await assert.rejects(
      locks.createPhoneMutex({lockPath, timeoutMs: 3000}).runUser(async () => { entered = true; }),
      /Phone mutex.*(unclean|recovery)/i
    );
    assert.equal(entered, false);
    finish();
    await assert.rejects(first, /Phone mutex lock lost/);
    await assert.rejects(
      locks.createPhoneMutex({lockPath}).runUser(async () => { entered = true; }),
      /Phone mutex.*(unclean|recovery)/i
    );
    assert.equal(entered, false);
  } finally { finish(); await first.catch(() => {}); await rm(dir, {recursive:true, force:true}); }
});
