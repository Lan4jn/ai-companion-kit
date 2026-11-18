import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { __debug } from '../src/bili-living.js';

const coverage = { complete:true, duration:4, segments:[{start:0,end:4,visual:'蓝色画面',subtitle:'你好'}] };
const playback = {fullWatchVerified:true, complete:true,start:0,end:4,duration:4,watched:4,samples:Array.from({length:9},(_,i)=>({time:i/2,wall:i/4,duration:4,rate:2,identity:true,paused:false,seeking:false,ended:i===8}))};
const decision = {interest:'like',like:true,comment:false,danmaku:false};
test('verified playback enables an explicit model decision without private context', async () => {
 let request; const result = await __debug.decideWatchReaction({brain:{complete:async x=>(request=x,JSON.stringify(decision))},coverage,playback,duration:4});
 assert.deepEqual(result,decision); assert.equal(request.diagnostic,true); assert.ok(!request.prompt.includes('private'));
});

test('no playback, uncertainty, invalid output and model failure cannot create interactions', async () => {
 let calls=0;
 const run = (value, p=playback) => __debug.decideWatchReaction({brain:{complete:async()=>{calls++; if (value instanceof Error) throw value; return value;}},coverage,playback:p,duration:4});
 assert.equal(await run(JSON.stringify(decision), {...playback,fullWatchVerified:false}),null);
 assert.equal(calls,0);
 for (const value of ['bad', JSON.stringify({...decision,interest:'unknown'}), JSON.stringify({...decision,interest:'dislike'}), new Error('unavailable')]) assert.equal(await run(value),null);
 assert.deepEqual(await run(JSON.stringify({interest:'dislike',like:false,comment:false,danmaku:false})),{interest:'dislike',like:false,comment:false,danmaku:false});
 assert.deepEqual(await run(JSON.stringify({interest:'unknown',like:false,comment:false,danmaku:false})),{interest:'unknown',like:false,comment:false,danmaku:false});
});

test('like checks prestate and poststate once, unknown submission is not retried', async () => {
 // 点赞留痕是跨运行持久的：先清掉本用例用到的 aid，否则 EEXIST 会按设计 fail-closed
 const markerDir=path.join(process.env.HOME || '/root','.bili-ai','like-attempts');
 for (const aid of [42,43,44]) fs.rmSync(path.join(markerDir,String(aid)),{force:true});
 const original=globalThis.fetch; let calls=[]; let replies=[];
 globalThis.fetch=async (url,opts)=>{calls.push({url,opts}); const v=replies.shift(); if(v instanceof Error) throw v; return {json:async()=>v};};
 try {
  replies=[{code:0,data:0},{code:0},{code:0,data:1}];
  assert.equal(await __debug.likeVideo(42,{cookie:'bili_jct=fixture'}),true); assert.equal(calls.length,3); assert.equal(calls[1].opts.method,'POST');
  calls=[]; replies=[{code:0,data:0},new Error('unknown')];
  assert.equal(await __debug.likeVideo(43,{cookie:'bili_jct=fixture'}),false); assert.equal(calls.length,2);
  calls=[]; replies=[{code:0,data:0}];
  assert.equal(await __debug.likeVideo(43,{cookie:'bili_jct=fixture'}),false); assert.equal(calls.length,1);
  calls=[]; replies=[{code:0,data:0},{code:0},{code:0,data:0}];
  assert.equal(await __debug.likeVideo(44,{cookie:'bili_jct=fixture'}),false); assert.equal(calls.length,3);
  calls=[]; replies=[{code:0,data:1}];
  assert.equal(await __debug.likeVideo(42,{cookie:'bili_jct=fixture'}),false); assert.equal(calls.length,1);
 } finally {globalThis.fetch=original;}
});
