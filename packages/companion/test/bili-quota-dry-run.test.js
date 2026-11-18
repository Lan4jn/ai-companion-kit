import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug, startBiliLiving, stopBiliLiving } from '../src/bili-living.js';
import { readFileSync } from 'node:fs';

test('follow and DM zero quota prohibits action while positive limits retain their boundary', () => {
  assert.equal(__debug.withinDailyLimit(0, 0), false);
  assert.equal(__debug.withinDailyLimit(0, 1), true);
  assert.equal(__debug.withinDailyLimit(1, 1), false);
  assert.equal(__debug.canComment({}, 'BVtest', 0).ok, true);
});

test('production Bilibili start receives global dry-run flag', () => {
  const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /startBiliLiving\(\{[\s\S]*?dryRun:\s*cfg\.dryRun[\s\S]*?\}\);/);
});

test('dry run never schedules Bilibili work even with credentials', async () => {
  let timers = 0;
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (...args) => { timers++; return original(...args); };
  try {
    startBiliLiving({dryRun:true, credentials:{cookie:'synthetic'}, initialDelayMs:600000});
    assert.equal(timers, 0);
  } finally { globalThis.setTimeout = original; await stopBiliLiving(); }
});
