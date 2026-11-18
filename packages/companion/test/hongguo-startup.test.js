import test from 'node:test';
import assert from 'node:assert/strict';
import * as hongguo from '../src/hongguo-integration.js';

test('production startup is inert by default and schedules enabled cycles, stopping on disconnect', async () => {
  assert.equal(typeof hongguo.startHongguoAutonomous, 'function');
  let scheduled = [], calls = [], cancelled = [];
  const timers = { set(fn, ms) { const t = { fn, ms }; scheduled.push(t); return t; }, clear(t) { cancelled.push(t); } };
  const disabled = hongguo.startHongguoAutonomous({ timers, createIntegration() { throw Error('must not start'); } });
  assert.equal(disabled.enabled, false);
  assert.equal(scheduled.length, 0);
  const old = process.env.PHONE_SERIAL;
  process.env.PHONE_SERIAL = '192.168.31.160:16384';
  try {
    const brain = { complete: async () => '{"want":false}' };
    const handle = hongguo.startHongguoAutonomous({ enabled: true, serial: process.env.PHONE_SERIAL, packageName: 'com.example.hongguo', brain, dataDir: '/private/data', intervalMs: 50, timers,
      createIntegration(opts) { calls.push(opts); return { async tick(options) { calls.push(options); return { status: 'stopped' }; } }; } });
    assert.equal(handle.enabled, true);
    assert.equal(calls[0].memoryDir, '/private/data');
    assert.equal(scheduled.length, 1);
    await scheduled[0].fn();
    assert.equal(calls[1].permission, true);
    assert.equal(calls[1].brain, brain);
    assert.equal(scheduled.length, 1);
    handle.stop();
  } finally { if (old === undefined) delete process.env.PHONE_SERIAL; else process.env.PHONE_SERIAL = old; }
});
