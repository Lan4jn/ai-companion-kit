import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {handleTurn} from '../src/index.js';
import {Brain} from '../src/brain.js';
import {Humanizer} from '../src/humanize.js';
import {execFileSync} from 'node:child_process';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
import {initializeManagedStore, createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);
const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
function authorizedConfig(dir) {
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 return {ownerIds:['1'],dataDir:dir,memoryBrain:{enabled:true,trustedProcess:true,trustedScope:{...scope},authorizedSources:['qq-private-message']}};
}
function managedStore(dir) {
 return createManagedMemoryBrain({directory:path.join(dir,'memory-brain-scoped'),scope,sources:['qq-private-message'],trustedProcess:true});
}
async function parseMessage(message) {
 let resolveMessage;
 const received = new Promise(resolve => { resolveMessage = resolve; });
 const bot = new OneBot({wsUrl:'ws://fixture',onMessage:resolveMessage});
 bot.api=async()=>({ok:false});
 bot.getMyGroupCard=async()=>'';
 while (!bot.ws) await new Promise(r=>setTimeout(r,1));
 bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:message.type || 'private',user_id:message.userId || 1,group_id:message.groupId,message_id:message.messageId,message:message.raw}));
 const msg=await received;
 bot.close();
 return msg;
}

test('real handleTurn, real engine and Brain: only QQ owner gets recalled memory', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-e2e-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const requests=[], sent=[];
 t.mock.method(globalThis,'fetch',async (_url,opts)=>{requests.push(JSON.parse(opts.body));return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'收到啦'}}]})};});
 const memory={dir,renderPerson:()=>'',renderRecent:()=>'',recallTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const brain=new Brain({apiKey:'fake',baseUrl:'https://example.invalid',model:'fake',role:{build:({situation})=>situation},memory,dataDir:dir});
 const deps={brain,memory,bot:{send:async (key,text)=>{sent.push({key,text});return {ok:true};},setTyping:async()=>{}},human:new Humanizer({enabled:false}),waker:{wake:()=>{}}};
 const cfg=authorizedConfig(dir);
 const base=await parseMessage({messageId:'123',raw:[{type:'text',data:{text:'苹果红色秘密花园'}}]});
 await handleTurn(deps,[base],cfg);
 assert.equal(sent.length,1);
 requests.length=0;
 await handleTurn(deps,[await parseMessage({messageId:'124',raw:[{type:'text',data:{text:'苹果花园'}}]})],cfg);
 assert.match(JSON.stringify(requests),/苹果红色秘密花园/);
 assert.match(JSON.stringify(requests),/onebot-message:123/);
 requests.length=0;
 await handleTurn(deps,[{...base,platform:'bili',messageId:'125',text:'苹果花园',raw:[{type:'text',data:{text:'苹果花园'}}]}],cfg);
 assert.doesNotMatch(JSON.stringify(requests),/苹果红色秘密花园/);
 for (const item of [
  {...base,key:'group:55',isGroup:true,messageId:'126',text:'苹果花园'},
  {...base,key:'private:2',userId:'2',messageId:'127',text:'苹果花园'},
  {...base,key:'private:1',messageId:'128',replyTo:'123',text:'苹果花园'},
 ]) {
  requests.length=0;
  await handleTurn(deps,[item],cfg);
  assert.doesNotMatch(JSON.stringify(requests),/苹果红色秘密花园/);
 }
 for (const item of [
  await parseMessage({messageId:'129',userId:2,raw:[{type:'text',data:{text:'苹果花园'}}]}),
  await parseMessage({messageId:'130',type:'group',groupId:55,raw:[{type:'text',data:{text:'苹果花园'}}]}),
  await parseMessage({messageId:'131',raw:[{type:'reply',data:{id:'123'}},{type:'text',data:{text:'苹果花园'}}]}),
 ]) {
  requests.length=0;
  await handleTurn(deps,[item],cfg);
  assert.ok(requests.length > 0, 'negative case must reach the real model request');
  assert.doesNotMatch(JSON.stringify(requests),/苹果红色秘密花园/);
 }
 await handleTurn(deps,[base],cfg);
 const db=path.join(dir,'memory-brain-scoped',fs.readdirSync(path.join(dir,'memory-brain-scoped')).find(f=>f.endsWith('.sqlite3')));
 const count=Number(execFileSync('/usr/bin/python3',['-c',"import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute(\"select count(*) from memories where json_extract(meta, '$.evidence') = 'onebot-message:123'\").fetchone()[0])",db],{encoding:'utf8'}));
 assert.equal(count,1,'replayed event must not be duplicated');
 const mb=managedStore(dir);
 for (const memoryBrain of [
  {enabled:true},
  {...cfg.memoryBrain,trustedProcess:false},
  {...cfg.memoryBrain,trustedScope:{...scope,user:'2'}},
  {...cfg.memoryBrain,authorizedSources:['other-source']},
 ]) {
  requests.length=0;
  await handleTurn(deps,[await parseMessage({messageId:'140',raw:[{type:'text',data:{text:'苹果未授权写入'}}]})],{...cfg,memoryBrain});
  assert.ok(requests.length>0,'ordinary chat must continue');
  assert.doesNotMatch(JSON.stringify(requests),/苹果红色秘密花园/);
 }
 assert.deepEqual((await mb.recall(scope,{query:'苹果未授权写入',sources:['qq-private-message']})).filter(h=>h.evidence==='onebot-message:140'),[]);
 await mb.revoke(scope,{source:'qq-private-message'});
 requests.length=0;
 await handleTurn(deps,[await parseMessage({messageId:'141',raw:[{type:'text',data:{text:'苹果花园'}}]})],cfg);
 assert.ok(requests.length>0);
 assert.doesNotMatch(JSON.stringify(requests),/苹果红色秘密花园/);
});

test('real OneBot HTTP confirmation gates the real memory write', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-real-send-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let success=true;
 t.mock.method(globalThis,'fetch',async()=>({ok:true,text:async()=>JSON.stringify(success ? {status:'ok',retcode:0,data:{message_id:777}} : {status:'failed',retcode:100})}));
 const bot=new OneBot({wsUrl:'ws://fixture',httpUrl:'http://fixture'}); t.after(()=>bot.close());
 bot.setTyping=async()=>{};
 const deps={brain:{reply:async()=>({text:'确认发送结果'})},memory:{renderPerson:()=>'',renderRecent:()=>'',recallTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}},bot,human:new Humanizer({enabled:false}),waker:{wake:()=>{}}};
 const cfg=authorizedConfig(dir);
 await handleTurn(deps,[await parseMessage({messageId:'950',raw:[{type:'text',data:{text:'成功苹果内容'}}]})],cfg);
 success=false;
 await handleTurn(deps,[await parseMessage({messageId:'951',raw:[{type:'text',data:{text:'失败苹果内容'}}]})],cfg);
 const mb=managedStore(dir);
 const hits=await mb.recall(scope,{query:'苹果',sources:['qq-private-message']});
 assert.deepEqual(hits.map(h=>h.evidence),['onebot-message:950']);
});

test('mutation during model reply cannot write forged memory', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-mutate-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory={dir,renderPerson:()=>'',renderRecent:()=>'',recallTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const msg=await parseMessage({messageId:'988',raw:[{type:'text',data:{text:'正常原文'}}]});
 const deps={brain:{reply:async()=>{msg.text='篡改后的秘密';return {text:'确认回复'};}},memory,bot:{send:async()=>({ok:true}),setTyping:async()=>{}},human:new Humanizer({enabled:false}),waker:{wake:()=>{}}};
 const cfg=authorizedConfig(dir);
 await handleTurn(deps,[msg],cfg);
 assert.deepEqual(await managedStore(dir).recall(scope,{query:'篡改后的秘密',sources:['qq-private-message']}),[]);
});

test('failed delivery does not persist incoming message', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-send-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory={dir,renderPerson:()=>'',renderRecent:()=>'',recallTurns:()=>[],remember:()=>{},logTurn:()=>{},touch:()=>{}};
 const deps={brain:{reply:async()=>({text:'确认回复'})},memory,bot:{send:async()=>({ok:false}),setTyping:async()=>{}},human:new Humanizer({enabled:false}),waker:{wake:()=>{}}};
 const msg=await parseMessage({messageId:'987',raw:[{type:'text',data:{text:'失败发送秘密'}}]});
 const cfg=authorizedConfig(dir);
 await handleTurn(deps,[msg],cfg);
 assert.deepEqual(await managedStore(dir).recall(scope,{query:'失败发送秘密',sources:['qq-private-message']}),[]);
});

test('concurrent duplicate evidence is idempotent and altered replay rejected', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-race-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const memory=createMemoryBrain({enabled:true,directory:dir,authorize:()=>true,recoveryAuthorization:()=>true});
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
 const record={source:'chat',text:'苹果秘密',evidence:'event-1'};
 const ids=await Promise.all(Array.from({length:4},()=>memory.remember(scope,record)));
 assert.equal(new Set(ids).size,1);
 await assert.rejects(memory.remember(scope,{...record,text:'伪造苹果'}));
});
