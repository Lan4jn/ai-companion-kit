import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateComposeHongguo } from '../src/hongguo-compose-navigation.js';
const cards=[{title:'剧甲',description:'热门',bounds:'[1,2][301,402]'}];
const snap=()=>({foreground:true,blocked:false,cards});
test('模型选择可见卡片，点击前重读并核对，无法核验播放时如实返回',async()=>{
 let calls=0,taps=0; const result=await navigateComposeHongguo({brain:{complete:async()=>'{"index":0}'},observe:async()=>{calls++;return snap()},tap:async()=>{taps++;return true},verify:async()=>false});
 assert.equal(result.status,'unverified');assert.equal(calls,2);assert.equal(taps,1);
});
test('候选明确标记从零开始的编号，允许自主跳过',async()=>{
 let prompt='';
 const result=await navigateComposeHongguo({brain:{complete:async args=>{prompt=args.prompt;return '{"index":null}'}},observe:async()=>snap(),tap:async()=>{throw Error('skip must not tap')},verify:async()=>false});
 assert.equal(result.status,'skipped');
 assert.match(prompt,/从0开始/);
 assert.match(prompt,/"index":0/);
});

test('模型跳过或界面变化时不点击',async()=>{
 for(const [response,observe] of [['{"index":null}',async()=>snap()],['{"index":0}',(()=>{let n=0;return async()=>++n===1?snap():{...snap(),cards:[]}})()]]){
 let taps=0;const result=await navigateComposeHongguo({brain:{complete:async()=>response},observe,tap:async()=>{taps++},verify:async()=>true});assert.notEqual(result.status,'verified');assert.equal(taps,0);
 }
});
