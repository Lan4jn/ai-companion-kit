import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDiaryScheduler } from '../src/diary-system.js';

test('diary stop waits for the active generation and prevents overlapping checks', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'diary-shutdown-'));
  const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval, OriginalDate = globalThis.Date;
  let check, release, calls = 0;
  globalThis.setInterval = fn => { check = fn; return 42; };
  globalThis.clearInterval = () => {};
  globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : ['2025-01-01T23:00:00'])); } };
  try {
    const stop = startDiaryScheduler({ dataDir: dir, brain: { reply: () => { calls++; return new Promise(r => { release = r; }); } } });
    const first = check(); check();
    assert.equal(calls, 1, 'overlapping timer checks must not generate twice');
    let stopped = false;
    const draining = Promise.resolve(stop()).then(() => { stopped = true; });
    await Promise.resolve(); assert.equal(stopped, false);
    check(); assert.equal(calls, 1);
    release({text:'# test'}); await first; await draining;
    assert.equal(stopped, true);
  } finally {
    globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; globalThis.Date = OriginalDate;
    fs.rmSync(dir, {recursive:true, force:true});
  }
});
