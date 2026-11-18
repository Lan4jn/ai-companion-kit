import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackEvidence } from '../src/bili-browser.js';

test('resumed position and seeking do not establish playback', () => {
  assert.equal(playbackEvidence({start:50,end:50,played:0}), 0);
  assert.equal(playbackEvidence({start:0,end:50,played:0}), 0);
  assert.equal(playbackEvidence({start:0,end:10,played:4}), 4);
});
