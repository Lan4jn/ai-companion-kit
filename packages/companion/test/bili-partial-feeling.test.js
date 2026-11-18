import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePartialBiliFeeling, validPartialBiliFeeling } from '../src/bili-partial-feeling.js';

const samples = Array.from({length:13}, (_,i)=>({time:i/2, wall:i/2, duration:20, rate:1, identity:true, seeking:false, paused:false, ended:false, ad:false}));
const input = () => ({ bvid:'BV1234567890', duration:20, coverage:{duration:20,segments:[{start:0,end:5,visual:'一只小猫趴在窗边'},{start:5,end:10,visual:'未播放的后续画面'}]}, browserResult:{ok:true,skipped:true,watched:6,playback:{samples,interrupted:false}}, brain:{complete:async()=>JSON.stringify({interest:'like',start:0,end:5,quote:'小猫趴在窗边',thought:'我喜欢这只小猫'})} });

test('early skip retains only an explicitly liked actually played excerpt', async()=>{
 const prompts=[]; const x=input(); const complete=x.brain.complete; x.brain.complete=async p=>{prompts.push(p.prompt);return complete(p)};
 const r=await choosePartialBiliFeeling(x);
 assert.ok(validPartialBiliFeeling(r)); assert.equal(r.biliFeeling.quote,'小猫趴在窗边');
 assert.doesNotMatch(prompts[0],/未播放的后续画面/); assert.doesNotMatch(JSON.stringify(r),/未播放的后续画面/);
});

test('rejects uninterested, invented quote, future segment, and full-watch claims', async()=>{
 for (const reply of [
  {interest:'unknown'}, {interest:'dislike'},
  {interest:'like',start:0,end:5,quote:'不存在',thought:'我喜欢'},
  {interest:'like',start:5,end:10,quote:'后续画面',thought:'我喜欢'},
  {interest:'like',start:0,end:5,quote:'小猫',thought:'我看完了全片'},
 ]) { const x=input(); x.brain.complete=async()=>JSON.stringify(reply); assert.equal(await choosePartialBiliFeeling(x),null); }
});

test('partial recordings reject missing player safety flags', async()=>{
 const x=input(); x.browserResult.playback.samples=structuredClone(samples); delete x.browserResult.playback.samples[2].paused;
 assert.equal(await choosePartialBiliFeeling(x),null);
});

test('rejects untrusted playback and altered records', async()=>{
 for (const change of [
  x=>x.browserResult.skipped=false, x=>x.browserResult.playback.interrupted=true,
  x=>x.browserResult.playback.samples[3].ad=true, x=>x.browserResult.playback.samples[3].paused=true,
  x=>x.browserResult.playback.samples[3].identity=false, x=>x.browserResult.playback.samples[3].seeking=true,
  x=>x.browserResult.playback.samples[3].time=15, x=>x.browserResult.watched=19,
  x=>x.coverage.duration=NaN, x=>x.bvid='BV1234567890extra',
 ]) { const x=structuredClone({...input(),brain:null}); x.brain=input().brain; change(x); assert.equal(await choosePartialBiliFeeling(x),null); }
 const r=await choosePartialBiliFeeling(input()); r.biliFeeling.evidence.segment.end=10; assert.equal(validPartialBiliFeeling(r),false);
});
