import test from 'node:test';
import assert from 'node:assert/strict';
import * as browser from '../src/bili-browser.js';
const continuousPlaybackEvidence = (...args) => browser.continuousPlaybackEvidence?.(...args) || {complete:false};
import { __debug } from '../src/bili-living.js';

const sample = (time, wall, extra={}) => ({time, wall, duration:10, rate:2, paused:false, seeking:false, identity:true, ...extra});
test('full playback requires continuous observed start to end, not a seek or resumed segment', () => {
  const full=Array.from({length:21},(_,i)=>sample(i*0.5,i*0.25,i===20?{ended:true}:{}));
  assert.equal(continuousPlaybackEvidence(full, false).complete, true);
  assert.equal(continuousPlaybackEvidence(full.slice(1), false).complete, false);
  assert.equal(continuousPlaybackEvidence([sample(0,0),sample(10,1,{ended:true})], false).complete, false);
  assert.equal(continuousPlaybackEvidence(full, true).complete, false);
  assert.equal(continuousPlaybackEvidence(full.map((x,i)=>i===1?{...x,identity:false}:x), false).complete, false);
  const spedUp=Array.from({length:15},(_,i)=>sample(Math.min(i*0.74,10),i*0.25,i===14?{ended:true}:{}));
  assert.equal(continuousPlaybackEvidence(spedUp, false).complete, false);
  assert.equal(continuousPlaybackEvidence([sample(0,0),sample(10,20,{ended:true})], false).complete, false);
});
test('follow/DM zero cap forbids actions and positive cap is enforced', () => {
  assert.equal(__debug.withinDailyLimit(10,0), false);
  assert.equal(__debug.withinDailyLimit(3,3), false);
  assert.equal(__debug.withinDailyLimit(2,3), true);
});
test('interaction options explicitly reach living context without changing defaults', () => {
  const opts={danmakuEnabled:false,danmakuChance:0,coinChance:0,followEnabled:false,followDailyMax:3,dmDailyMax:4};
  const result=__debug.interactionOptions(opts);
  for (const [key,value] of Object.entries(opts)) assert.equal(result[key],value);
});
