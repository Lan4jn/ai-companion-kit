import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Brain } from '../src/brain.js';
import { saveKnowledge, recallKnowledge, __debug } from '../src/bili-living.js';

function setup(t) {
  const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'watch-adversarial-'));
  const old=process.env.HOME; process.env.HOME=home;
  t.after(()=>{process.env.HOME=old;fs.rmSync(home,{recursive:true,force:true})});
  return home;
}
function makeBrain(dir,recall=()=>[]) {return new Brain({apiKey:'test',baseUrl:'http://invalid.local',model:'test',dataDir:dir,role:{build:({situation})=>situation},memory:{renderPerson:()=>'',renderRecent:()=>'',renderDiary:()=>''},recall})}
const samples=Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration:10,rate:2,identity:true,paused:false,seeking:false,ended:i===10}));
const coverage={complete:true,duration:10,segments:[{start:0,end:10,visual:'企鹅跳舞'}]};
const playback={complete:true,fullWatchVerified:true,start:0,end:10,duration:10,watched:10,samples};
const evidence={version:2,sources:['visual'],coverage,playback};
const video={bvid:'BV11T411P7o1',title:'木星养企鹅的奇妙故事',duration:10};
const knowledge={points:[{source:'visual',start:0,end:10,quote:'企鹅跳舞'}]};
test('implicit video questions are answered with a no-fabrication constraint',async t=>{
 const dir=setup(t);
 const reqs=[];
 t.mock.method(globalThis,'fetch',async (_u,o)=>{reqs.push(JSON.parse(o.body));return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'没看过那个'}}]})}});
 for(const text of ['你看过木星养企鹅吗','看没看那个视频']) {
  const result=await makeBrain(dir).reply({key:'private:578021239',userId:'578021239',text,record:false,tools:false});
  assert.match(result.text,/没看过|不知道|不记得/);
 }
 assert.ok(reqs.length>0,'无记录时应调用模型但带约束');
 assert.match(JSON.stringify(reqs[0].messages),/没有可靠观看记录/);
});
test('B站 DM no evidence returns deterministic JSON without calling model or recall',async t=>{
 const dir=setup(t); t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected model call')});
 const result=await makeBrain(dir,()=>{throw Error('cross-session recall')}).reply({key:'private:bili:42',platform:'bilibili',userId:'578021239',text:'你看过木星养企鹅吗？只输出 JSON：{"reply":false} 或 {"reply":true,"text":"..."}',record:false,tools:false});
 const value=JSON.parse(result.text); assert.equal(value.reply,true); assert.match(value.text,/没找到|不知道/);
});
test('explicit reply JSON contract fails closed outside DM too',async t=>{
 const dir=setup(t); t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected model call')});
 const result=await makeBrain(dir).reply({key:'group:42',userId:'578021239',text:'你看过的视频讲了什么？只输出 JSON：{"reply":true,"text":"..."}',record:false,tools:false});
 const value=JSON.parse(result.text); assert.equal(value.reply,true); assert.match(value.text,/没找到|不知道/);
});
test('tiny watched and forged or missing sample trajectories cannot verify a complete watch',async t=>{
 setup(t);
 assert.equal(saveKnowledge(video,knowledge,{...evidence,playback:{...playback,watched:0.001}}),null);
 assert.equal(saveKnowledge(video,knowledge,{...evidence,playback:{...playback,samples:undefined}}),null);
 assert.equal(saveKnowledge(video,knowledge,{...evidence,playback:{...playback,samples:samples.map(s=>({...s,wall:s.wall/100}))}}),null);
 assert.equal(saveKnowledge(video,knowledge,{...evidence,playback:{...playback,samples:samples.map((s,i)=>({...s,duration:i===5?100:s.duration}))}}),null);
 const result=await __debug.verifyFullWatch({coverage,expectedDuration:10,browserWatch:async()=>({ok:true,watched:0.001,playback})});
 assert.equal(result.complete,false);
 assert.ok(saveKnowledge(video,knowledge,evidence));
});
test('sequel query cannot recall original even with a long shared title',t=>{
 setup(t); assert.ok(saveKnowledge(video,knowledge,evidence));
 assert.deepEqual(recallKnowledge('你看过木星养企鹅的奇妙故事第二集吗'),[]);
});
