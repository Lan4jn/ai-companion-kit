import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recallKnowledge } from '../src/bili-living.js';
import { Brain } from '../src/brain.js';
import { Waker } from '../src/wake.js';
import { tiebaMessage } from './tieba-trusted-message-fixture.js';

const fixture = { duration:10, bvid:'BV11T411P7o1', title:'15秒搞笑段子，看一遍笑一遍', summary:'', points:['低可信画面模型观察（0-10秒，可能误识）：网聊查户口先问地址年龄性别'], tags:[], observations:[{source:'visual',start:0,end:10,quote:'网聊查户口先问地址年龄性别'}], evidence:{version:2,sources:['visual'],coverage:{complete:true,duration:10,segments:[{start:0,end:10,visual:'网聊查户口先问地址年龄性别'}]},playback:{complete:true,fullWatchVerified:true,duration:10,start:0,end:10,watched:10,samples:Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration:10,rate:2,identity:true,paused:false,seeking:false,ended:i===10}))}} };
test('natural language finds relevant video without matching the whole sentence', t => {
 const old=process.env.HOME, home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-recall-')); t.after(()=>{process.env.HOME=old;fs.rmSync(home,{recursive:true,force:true})});
 process.env.HOME=home; const file=path.join(home,'ai-companion-xiaoyu/ai-companion-kit/packages/companion/data/bili-knowledge.jsonl'); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(fixture)+'\n');
 assert.equal(recallKnowledge('你在B站看的那个网聊查户口的搞笑视频讲了什么？')[0]?.bvid,fixture.bvid);
 assert.deepEqual(recallKnowledge('你看过的火星种土豆视频讲了什么？'),[]);
});

test('unmatched watched-video question must not be fabricated', async t => {
 let request;
 t.mock.method(globalThis,'fetch',async (_u,o)=>{request=JSON.parse(o.body);return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'没看过那个，别瞎问'}}]})}});
 const memory={renderPerson:()=>'',renderRecent:()=>'',renderDiary:()=>''};
 const brain=new Brain({apiKey:'unused',role:{build:({situation=''})=>situation},memory,recall:()=>[]});
 const result=await brain.reply({key:'private:578021239',userId:'578021239',text:'你看过的火星种土豆视频讲了什么？',record:false,tools:false});
 assert.match(JSON.stringify(request.messages),/没有可靠观看记录/,'无记录时必须约束模型不编造');
 assert.match(result.text,/没看过|不记得|不知道/);
});

test('video recall is not accessed for group or other-platform conversations', async t => {
 let calls=0;
 t.mock.method(globalThis,'fetch',async ()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'没看过'}}]})}));
 const memory={renderPerson:()=>'',renderRecent:()=>'',renderDiary:()=>''};
 const brain=new Brain({apiKey:'unused',role:{build:({situation=''})=>situation},memory,recall:()=>{calls++;return [fixture];}});
 for (const input of [
  {key:'group:123',userId:'578021239'},
  {key:'private:578021239',userId:'578021239',platform:'bilibili'},
  {key:'private:999',userId:'999'}]) {
  const result=await brain.reply({...input,text:'你看过的网聊查户口视频讲了什么？',record:false,tools:false});
  assert.match(result.text,/没看过|不知道|不记得|没找到/);
 }
 assert.equal(calls,0);
});


test('owner QQ joined turn injects matching real recall into the model request', async t => {
 const oldHome=process.env.HOME, home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-chat-'));
 process.env.HOME=home;
 t.after(()=>{process.env.HOME=oldHome;fs.rmSync(home,{recursive:true,force:true})});
 const file=path.join(home,'ai-companion-xiaoyu/ai-companion-kit/packages/companion/data/bili-knowledge.jsonl');
 fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(fixture)+'\n');
 let request;
 t.mock.method(globalThis, 'fetch', async (_url, options) => {
  request=JSON.parse(options.body);
  return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'看过这个片段'}}]})};
 });
 const brain=new Brain({apiKey:'unused',baseUrl:'http://invalid.local',model:'test',dataDir:home,ownerIds:['578021239'],
  role:{build:({situation})=>situation},memory:{renderPerson:()=>'',renderRecent:()=>'',renderDiary:()=>''},recall:recallKnowledge});
 const event = await tiebaMessage({userId:578021239,text:'你在B站看的那个网聊查户口的搞笑视频讲了什么？'});
 const text=Waker.joinBatch([event],['578021239']);
 const result=await brain.reply({key:event.key,userId:event.userId,qqEvent:event,text,record:false,tools:false});
 assert.equal(result.text,'看过这个片段');
 assert.ok(request.messages.some(m=>String(m.content).includes(fixture.points[0])));
 assert.ok(request.messages.some(m=>String(m.content).includes(text)));
});
