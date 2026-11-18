import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The actual production entry point must not launch a display/browser, even if
// its opt-in caller provides a private IPC channel and a valid session directory.
test('real headed daemon fails closed until enforced egress isolation exists', {timeout: 10000}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-egress-closed-'));
  let child;
  try {
    child = fork(path.resolve('src/douyin-headed-daemon.js'), [], {
      env: {...process.env, DOUYIN_LOGIN_SESSION_DIR: dir},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const messages = [];
    child.on('message', message => messages.push(message));
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({code, signal}));
      setTimeout(() => { child.kill('SIGKILL'); reject(Error('daemon did not fail closed')); }, 5000).unref();
    });
    assert.notEqual(result.code, 0);
    assert.deepEqual(messages, []);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    child?.kill();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
