import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { __debug } from '../src/bili-living.js';
import { Memory } from '../src/memory.js';
import { validBiliFeeling } from '../src/bili-feeling-memory.js';

const samples=Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration:10,rate:2,identity:true,paused:false,seeking:false,ended:i===10}));
const playback={complete:true,fullWatchVerified:true,duration:10,start:0,end:10,watched:10,samples};
async function entry(source='字幕') {
 let n=0;
 const mood=await __debug.summarizeForDiary({reply:async()=>({text:++n===1?JSON.stringify({thought:'我有点好奇。',quote:'星空真美'}):'{"safe":true}'})},`${source}（0-10秒，可能误识）：星空真美`);
 return __debug.buildBiliDiary([{played:true,bvid:'BV11T411P7o1',duration:10,coverage:{complete:true,duration:10,segments:[{start:0,end:10,visual:'人物挥手',subtitle:'星空真美'}]},playback,diaryMood:mood}]);
}
test('字幕感想记录证据源与引用一致，缺失声明时拒绝召回',async()=>{
 const rec=await entry();
 assert.ok(rec.biliFeeling.evidence.sources.includes('subtitle'));
 assert.equal(validBiliFeeling(rec),true);
 rec.biliFeeling.evidence.sources=['visual'];
 assert.equal(validBiliFeeling(rec),false);
});
test('老爸自然询问最近B站看了什么可召回真实感想',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-natural-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=new Memory({dir}); memory.logDiary(await entry());
 assert.match(memory.recallBiliFeelings('你最近在B站有啥好看的？'),/我有点好奇/);
});
