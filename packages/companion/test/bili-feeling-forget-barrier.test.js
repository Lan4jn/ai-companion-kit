import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {Memory} from '../src/memory.js';
import {Brain} from '../src/brain.js';
import {OneBot} from '../src/transport-onebot.js';
import {gatherTodayContext} from '../src/diary-system.js';
import {__debug} from '../src/bili-living.js';
import {handleTurn} from '../src/index.js';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

async function ownerEvent(text='你最近在B站有啥好看的？', user=1, type='private') {
 let done; const p=new Promise(r=>done=r); const bot=new OneBot({wsUrl:'ws://fixture',onMessage:done});
 bot.api=async()=>({ok:false});
 try {
  for (let i=0; !bot.ws && i<1000; i++) await new Promise(r=>setTimeout(r,1));
  assert.ok(bot.ws, 'fixture WebSocket did not initialize');
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:type,user_id:user,group_id:55,message_id:123,message:[{type:'text',data:{text}}]}));
  let timer;
  try { return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture message not delivered')),2000)})]); }
  finally { clearTimeout(timer); }
 } finally { bot.close(); }
}
async function entry(bvid, thought) {
 let n=0; const mood=await __debug.summarizeForDiary({reply:async()=>({text:++n===1?JSON.stringify({thought,quote:'人物挥手'}):'{"safe":true}'})},'画面模型观察（0-10秒，可能误识）：人物挥手');
 const samples=Array.from({length:11},(_,i)=>({time:i,wall:i/2,duration:10,rate:2,identity:true,paused:false,seeking:false,ended:i===10}));
 return __debug.buildBiliDiary([{played:true,bvid,duration:10,coverage:{complete:true,duration:10,segments:[{start:0,end:10,visual:'人物挥手'}]},playback:{complete:true,fullWatchVerified:true,duration:10,start:0,end:10,watched:10,samples},diaryMood:mood}]);
}
test('owner feeling recall filters each candidate before limiting results',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'feeling-barrier-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=new Memory({dir}); memory.logDiary(await entry('BV11T411P7o1','我觉得很温暖。'));
 for (const id of ['BV11T411P7o2','BV11T411P7o3','BV11T411P7o4']) memory.logDiary(await entry(id,'我感到很难过。'));
 let messages=[]; t.mock.method(globalThis,'fetch',async (_url,opts)=>{messages=JSON.parse(opts.body).messages; return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好'}}]})};});
 const event=await ownerEvent();
 assert.equal(memory.biliFeelingCandidates('你最近在B站有啥好看的？').length,4);
 const brain=new Brain({apiKey: String.fromCharCode(102,105,120,116,117,114,101), baseUrl: "https://model.invalid/v1", memory, dataDir:dir, ownerIds:["1"]});
 const barrier=async rows=>rows.filter(r=>r.biliFeeling?.bvid==='BV11T411P7o1');
 const result=await brain.reply({key:event.key,userId:event.userId,qqEvent:event,text:'你最近在B站有啥好看的？',factualSearchText:'你好',record:false,tools:false,nativeBiliBarrier:barrier});
 assert.ok(messages.length, JSON.stringify(result));
 const prompt=JSON.stringify(messages); assert.match(prompt,/我觉得很温暖/); assert.doesNotMatch(prompt,/我感到很难过/);
});

test('managed native barrier honors tombstones and exact owner scope',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'feeling-managed-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['bili-observation'],trustedProcess:true});
 const memory=new Memory({dir}); memory.logDiary(await entry('BV11T411P7o1','我觉得很温暖。')); memory.logDiary(await entry('BV11T411P7o2','我感到很难过。'));
 await store.forget(scope,{source:'bili-observation',evidence:'https://www.bilibili.com/video/BV11T411P7o2'});
 assert.doesNotMatch(gatherTodayContext(dir),/我感到很难过/);
 assert.doesNotMatch(memory.renderDiary(6,{includeBiliFeelings:true}),/我感到很难过/);
 const event=await ownerEvent(); let captured;
 const context={brain:{reply:async p=>{captured=p;return {text:''}}},memory,bot:{},human:{},waker:{}};
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['bili-observation']}};
 await handleTurn(context,[event],cfg);
 const candidates=memory.biliFeelingCandidates('你最近在B站有啥好看的？');
 const filtered=await captured.nativeBiliBarrier(candidates);
 assert.deepEqual(filtered.map(x=>x.biliFeeling.bvid),['BV11T411P7o1']);
 let messages=[]; t.mock.method(globalThis,'fetch',async (_url,opts)=>{messages=JSON.parse(opts.body).messages;return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好'}}]})}});
 const brain=new Brain({apiKey: String.fromCharCode(102,105,120,116,117,114,101), baseUrl: "https://model.invalid/v1", memory, dataDir:dir, ownerIds:["1"]});
 const input={key:event.key,userId:event.userId,qqEvent:event,text:'你最近在B站有啥好看的？',factualSearchText:'你好',record:false,tools:false,nativeBiliBarrier:captured.nativeBiliBarrier};
 await brain.reply(input); assert.match(JSON.stringify(messages),/我觉得很温暖/); assert.doesNotMatch(JSON.stringify(messages),/我感到很难过/);
 messages=[]; await brain.reply({...input,qqEvent:{...event}}); assert.doesNotMatch(JSON.stringify(messages),/我觉得很温暖|我感到很难过/);
 messages=[]; await brain.reply({...input,nativeBiliBarrier:async()=>{throw Error('unavailable')}}); assert.doesNotMatch(JSON.stringify(messages),/我觉得很温暖|我感到很难过/);
 await handleTurn(context,[event],{...cfg,memoryBrain:{...cfg.memoryBrain,trustedScope:{...scope,user:'2'}}});
 assert.deepEqual(await captured.nativeBiliBarrier(candidates),[]);
 await handleTurn(context,[event],{...cfg,memoryBrain:{...cfg.memoryBrain,authorizedSources:['qq-private-message']}});
 assert.deepEqual(await captured.nativeBiliBarrier(candidates),[], 'unauthorized source must fail closed');
});


test('real handleTurn routes owner natural personal recall before factual preflight', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'feeling-turn-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['bili-observation'],trustedProcess:true});
 const memory=new Memory({dir}); memory.logDiary(await entry('BV11T411P7o1','我觉得很温暖。')); memory.logDiary(await entry('BV11T411P7o2','我感到很难过。'));
 await store.forget(scope,{source:'bili-observation',evidence:'https://www.bilibili.com/video/BV11T411P7o2'});
 let messages=[]; let searches=0;
 t.mock.method(globalThis,'fetch',async (_url,opts)=>{messages=JSON.parse(opts.body).messages;return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好'}}]})}});
 const brain=new Brain({apiKey: String.fromCharCode(102,105,120,116,117,114,101), baseUrl: "https://model.invalid/v1", memory, dataDir:dir, ownerIds:["1"]});
 brain.search=async()=>{searches++;return {success:false}};
 const cfg={ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['bili-observation']}};
 await handleTurn({brain,memory,bot:{},human:{say:async()=>({ok:true})},waker:{}},[await ownerEvent()],cfg);
 assert.match(JSON.stringify(messages),/我觉得很温暖/);
 assert.doesNotMatch(JSON.stringify(messages),/我感到很难过/);
 assert.equal(searches,0);
 messages=[];
 await handleTurn({brain,memory,bot:{},human:{say:async()=>({ok:true})},waker:{}},[await ownerEvent('你最近在B站看了哪些视频？')],cfg);
 assert.match(JSON.stringify(messages),/我觉得很温暖/);
 assert.doesNotMatch(JSON.stringify(messages),/我感到很难过/);
 assert.equal(searches,0);
 // Public factual requests retain factual search and never inject personal feelings.
 messages=[];
 await handleTurn({brain,memory,bot:{},human:{say:async()=>({ok:true})},waker:{}},[await ownerEvent('B站最近热门视频有哪些？')],cfg);
 assert.doesNotMatch(JSON.stringify(messages),/我觉得很温暖|我感到很难过/);
 messages=[];
 await handleTurn({brain,memory,bot:{},human:{say:async()=>({ok:true})},waker:{}},[await ownerEvent('影之刃零最新发售时间是什么？')],cfg);
 assert.equal(searches,1);
 assert.doesNotMatch(JSON.stringify(messages),/我觉得很温暖|我感到很难过/);
 // Even the same personal wording must not expose the owner's records elsewhere.
 for (const event of [await ownerEvent('你最近在B站有啥好看的？',2),await ownerEvent('你最近在B站有啥好看的？',1,'group')]) {
   messages=[];
   await handleTurn({brain,memory,bot:{},human:{say:async()=>({ok:true})},waker:{}},[event],cfg);
   // Some handleTurn paths can decline to generate; explicitly exercise Brain too.
   messages=[];
   await brain.reply({key:event.key,userId:event.userId,qqEvent:event,text:'私聊',record:false,tools:false,nativeBiliBarrier:async rows=>rows});
   assert.ok(messages.length, 'non-owner/group request must actually reach the model');
   assert.doesNotMatch(JSON.stringify(messages),/我觉得很温暖|我感到很难过/);
 }
});
