import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createPhoneMutex, assertPhoneLock } from '../src/phone-mutex.js';
import { startPhoneLiving, stopPhoneLiving, getPhoneLivingStatus } from '../src/phone-living.js';

// Execute the actual dormant loop in a sandbox; never run its legacy device actions.
function loadLoop(phoneMutex, stepAutonomousAction) {
  const source = readFileSync(new URL('../src/phone-living.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async function loop() {', source.indexOf('export function startPhoneLiving'));
  const end = source.indexOf('\n  daemonTimer = setTimeout(loop, 3000);', start);
  assert.ok(start !== -1 && end !== -1);
  const scheduled = [];
  const context = { phoneMutex, stepAutonomousAction, isDaemonRunning: true, daemonTimer: null,
    setTimeout: (fn, delay) => { scheduled.push(delay); return 1; } };
  const loop = vm.runInNewContext(`${source.slice(start, end)}\nloop`, context);
  return { loop, scheduled };
}

test('dormant loop holds phone mutex and skips while a user owns it', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'phone-living-lock-'));
  try {
    const mutex = createPhoneMutex({ lockPath: path.join(dir, 'lock') });
    let count = 0;
    const { loop, scheduled } = loadLoop(mutex, async () => { assertPhoneLock(); count++; return 1234; });
    await loop();
    assert.equal(count, 1);
    assert.equal(scheduled[0], 1234);
    await mutex.runUser(async () => { await loop(); });
    assert.equal(count, 1);
    assert.ok(scheduled[1] > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('production start keeps legacy random actions disabled', () => {
  startPhoneLiving();
  try { assert.equal(getPhoneLivingStatus().mode, 'unavailable'); }
  finally { stopPhoneLiving(); }
});
