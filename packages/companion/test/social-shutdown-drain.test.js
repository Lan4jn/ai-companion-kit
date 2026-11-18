import test from 'node:test';
import assert from 'node:assert/strict';
import { startBiliLiving, stopBiliLiving } from '../src/bili-living.js';
import { startDouyinLiving, stopDouyinLiving } from '../src/douyin-living.js';
for (const [name, start, stop] of [['bili', startBiliLiving, stopBiliLiving], ['douyin', startDouyinLiving, stopDouyinLiving]]) {
  test(`${name} stop returns a drain promise`, async () => {
    const result = stop(); assert.equal(typeof result?.then, 'function'); await result;
  });
  test(`${name} waits for active scheduled work and prevents rescheduling`, async () => {
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, random = Math.random;
    const timers = new Map(); let next = 0, release, entered;
    const gate = new Promise(r => { release = r; });
    const started = new Promise(r => { entered = r; });
    globalThis.setTimeout = fn => { const id = ++next; timers.set(id, fn); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    Math.random = () => 0.5;
    let calls = 0;
    try {
      start({ brain: { complete: async () => '{"want":true}' }, skipChance: 0, initialDelayMs: 0, backgroundWork: async () => { calls++; entered(); await gate; return { success: false }; } });
      const [id, fn] = [...timers.entries()][name === 'bili' ? 1 : 0];
      timers.delete(id); fn();
      // Fail explicitly if an upstream consent gate prevents work from starting.
      let deadline;
      try {
        await Promise.race([started, new Promise((_, reject) => {
          deadline = originalSet(() => reject(new Error(`${name} background work did not start`)), 1000);
        })]);
      } finally { originalClear(deadline); }
      let done = false; const draining = stop().then(() => { done = true; });
      await Promise.resolve(); assert.equal(done, false);
      release(); await draining;
      assert.equal(calls, 1); assert.equal(timers.size, 0);
    } finally {
      release(); await stop(); globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; Math.random = random;
    }
  });
}
