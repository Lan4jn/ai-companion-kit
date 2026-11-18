import test from 'node:test';
import assert from 'node:assert/strict';
import { continuousPlaybackEvidence, watchVideoPage } from '../src/bili-browser.js';
import { __debug } from '../src/bili-living.js';

test('corrected duration with continuous native endpoint passes media-verified gate despite overlapping old played ranges', async () => {
  const duration = 32.433;
  const samples = Array.from({length: 66}, (_, i) => ({time: Math.min(i * 0.5, duration), wall: Math.min(i * 0.5, duration) / 2, duration: i < 4 ? 33 : duration, rate: 2, ad: false, paused: i === 65, ended: i === 65, seeking: false, identity: true}));
  const page = { evaluate: async () => ({samples, interrupted:false, baseline:{time:0, played:1.633}, final:{time:duration, played:duration, duration, ranges:[[0,duration]]}}) };
  const playback = await watchVideoPage(page);
  assert.equal(playback.playback.complete, true);
  assert.equal(playback.watched, duration);
  const missingAdEvidence = await watchVideoPage({evaluate:async()=>({samples:samples.map(({ad,...s})=>s), interrupted:false, baseline:{time:0,played:1.633}, final:{time:duration,played:duration,duration,ranges:[[0,duration]]}})});
  assert.equal(missingAdEvidence.watched, 0);
  const interrupted = await watchVideoPage({evaluate:async()=>({samples, interrupted:true, baseline:{time:0,played:1.633}, final:{time:duration,played:duration,duration,ranges:[[0,duration]]}})});
  assert.equal(interrupted.playback.complete, false);
  const coverage = {complete:true, duration, segments:[{start:0,end:duration,visual:'画面'}]};
  const result = await __debug.verifyFullWatch({coverage, expectedDuration:33, browserWatch:async()=>({ok:true,...playback})});
  assert.equal(result.complete, true);
});

test('early endpoint cannot pass corrected duration against independently verified media', async () => {
  const duration=32.433, cutoff=30.8;
  const samples=Array.from({length:63},(_,i)=>({time:Math.min(i*.5,cutoff), wall:Math.min(i*.5,cutoff)/2, duration:i<4?33:cutoff, rate:2, paused:i===62, ended:i===62, seeking:false, identity:true}));
  const trace=continuousPlaybackEvidence(samples);
  const coverage={complete:true,duration,segments:[{start:0,end:duration,visual:'画面'}]};
  const result=await __debug.verifyFullWatch({coverage,expectedDuration:33,browserWatch:async()=>({ok:true,watched:cutoff,playback:{...trace,samples}})});
  assert.equal(result.complete,false);
});
