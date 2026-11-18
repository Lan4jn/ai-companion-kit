import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Humanizer } from '../src/humanize.js';

for (const enabled of [false, true]) {
  test(`say does not count blocked output (enabled=${enabled})`, async () => {
    const result = await new Humanizer({ enabled }).say(['first'], {
      sleep: async () => {}, send: async () => ({ ok: true, blocked: true, reason: 'CLEANED_EMPTY' }),
    });
    assert.equal(result.sent, 0);
    assert.equal(result.ok, false);
  });
  test(`say stops and reports confirmed sends on rejection (enabled=${enabled})`, async () => {
    const calls = [];
    const result = await new Humanizer({ enabled }).say(['first', 'second', 'third'], {
      sleep: async () => {},
      send: async part => { calls.push(part); return part === 'second' ? { ok: false, error: 'offline' } : { ok: true }; },
    });
    assert.equal(result.sent, 1);
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['first', 'second']);
  });
}
