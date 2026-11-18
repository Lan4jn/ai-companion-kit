import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPhoneMutex } from '../src/phone-mutex.js';

const moduleUrl = new URL('../src/phone-mutex.js', import.meta.url).href;
function holder(lockPath) {
  const code = `import {createPhoneMutex} from ${JSON.stringify(moduleUrl)}; await createPhoneMutex({lockPath:process.argv[1]}).runUser(async()=>{console.log('locked');await new Promise(r=>{process.stdin.resume();process.stdin.once('end',r)});});`;
  return spawn(process.execPath, ['--input-type=module', '-e', code, lockPath], {stdio:['pipe','pipe','pipe']});
}
async function ready(child) {
  const [data] = await once(child.stdout, 'data');
  assert.match(data.toString(), /locked/);
}
test('holder death before parent processes acquisition never runs callback', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-mutex-test-'));
  const lockPath = path.join(dir, 'phone.lock');
  const code = `
    import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const spawn = cp.spawn;
    cp.spawn = (...args) => {
      const child = spawn(...args); const once = child.stdout.once;
      child.stdout.once = function(event, callback) {
        if (event === 'data') return once.call(this, event, (...data) => {
          child.kill('SIGKILL'); child.once('exit', () => callback(...data));
        });
        return once.call(this, event, callback);
      }; return child;
    };
    syncBuiltinESMExports();
    const {createPhoneMutex} = await import(${JSON.stringify(moduleUrl)});
    try { await createPhoneMutex({lockPath:process.argv[1]}).runUser(async () => console.log('ENTERED')); }
    catch (e) { console.log('REJECTED', e.message); }
  `;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, lockPath], {stdio:['ignore','pipe','pipe']});
    let output = ''; child.stdout.on('data', s => { output += s; });
    const [exitCode] = await once(child, 'exit');
    assert.equal(exitCode, 0);
    assert.doesNotMatch(output, /ENTERED/);
    assert.match(output, /REJECTED/);
    await assert.rejects(createPhoneMutex({lockPath}).runUser(async () => {}), /unclean/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test('background skips while another process owns phone', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-mutex-test-'));
  const lockPath = path.join(dir, 'phone.lock');
  const child = holder(lockPath);
  try {
    await ready(child);
    assert.equal(await createPhoneMutex({lockPath}).tryBackground(async()=>{}), false);
  } finally {
    child.stdin.end(); await once(child, 'exit'); await rm(dir, {recursive:true, force:true});
  }
});


test('user waits across processes then acquires after release', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-mutex-test-'));
  const lockPath = path.join(dir, 'phone.lock'); const child = holder(lockPath);
  try {
    await ready(child); let entered = false;
    const pending = createPhoneMutex({lockPath, timeoutMs: 3000}).runUser(async () => { entered = true; });
    await new Promise(r => setTimeout(r, 200)); assert.equal(entered, false);
    child.stdin.end(); await once(child, 'exit'); await pending; assert.equal(entered, true);
  } finally { child.kill(); await rm(dir, {recursive:true, force:true}); }
});

test('waiting user times out without executing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-mutex-test-'));
  const lockPath = path.join(dir, 'phone.lock'); const child = holder(lockPath);
  try {
    await ready(child); let entered = false;
    await assert.rejects(createPhoneMutex({lockPath, timeoutMs: 150}).runUser(async () => { entered = true; }), /timed out/);
    assert.equal(entered, false);
  } finally { child.stdin.end(); await once(child, 'exit'); await rm(dir, {recursive:true, force:true}); }
});

test('killed owner quarantines subsequent callers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-mutex-test-'));
  const lockPath = path.join(dir, 'phone.lock'); const child = holder(lockPath);
  try {
    await ready(child); child.kill('SIGKILL'); await once(child, 'exit');
    await assert.rejects(createPhoneMutex({lockPath, timeoutMs: 3000}).runUser(async () => {}), /unclean.*recovery/i);
  } finally { child.kill(); await rm(dir, {recursive:true, force:true}); }
});

test('waiting user prevents background from overtaking', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phone-mutex-test-'));
  const lockPath = path.join(dir, 'phone.lock'); const child = holder(lockPath);
  try {
    await ready(child); let release;
    const gate = new Promise(r => { release = r; });
    const pending = createPhoneMutex({lockPath, timeoutMs: 3000}).runUser(async () => { await gate; });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(await createPhoneMutex({lockPath}).tryBackground(async () => {}), false);
    child.stdin.end(); await once(child, 'exit'); release(); await pending;
  } finally { child.kill(); await rm(dir, {recursive:true, force:true}); }
});
