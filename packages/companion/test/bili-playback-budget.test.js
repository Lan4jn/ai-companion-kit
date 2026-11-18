import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug } from '../src/bili-living.js';
const fullPlaybackSeconds = (...args) => __debug.fullPlaybackSeconds?.(...args);

test('full playback gets enough wall time even with legacy 20 second setting', () => {
  assert.equal(fullPlaybackSeconds({duration: 100, rate: 2, configuredSeconds: 20}), 55);
  assert.equal(fullPlaybackSeconds({duration: 10, rate: 2, configuredSeconds: 20}), 20);
  assert.equal(fullPlaybackSeconds({duration: 0, rate: 2, configuredSeconds: 20}), null);
});
