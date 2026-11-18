import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import * as batches from '../src/chat-durable-batch-candidate.js';
import {createDurableToolEffects} from '../src/chat-durable-tool-effects.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('generation identity is durably unknown before effects and cannot replay', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'pregen-')); let bot,journal;
 try {
  let receive; const got=new Promise(r=>receive=r);
  bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic'}}]}));
  const msg=await got, sealKey=Buffer.alloc(32,9), key=Buffer.alloc(32,8);
  journal=new EncryptedChatJournal({directory:dir,key}); let queue=new batches.DurableBatchCandidate(journal);
  const {session}=batches.createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
  let calls=0, id;
  const gen=batches.createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async(messages,identity)=>{
   calls++; id=identity.batchId; const row=queue.list(session)[0];
   assert.equal(row.state,'generation-unknown'); assert.equal(row.id,id);
   assert.equal(row.destination,'private:123'); assert.equal(row.inputs[0].message.text,'synthetic');
   assert.equal(JSON.parse(identity.batch)[0].text,'synthetic'); throw Error('simulated crash');
  }});
  await assert.rejects(gen.form(session,1),/simulated crash/);
  journal.close(); journal=new EncryptedChatJournal({directory:dir,key}); queue=new batches.DurableBatchCandidate(journal);
  const replay=batches.createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async()=>{calls++;return ['bad']}});
  await assert.rejects(replay.form(session,1),/blocked|consecutive/);
  assert.equal(queue.list(session)[0].id,id); assert.equal(calls,1);
 } finally {bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('successful generation preserves batch identity and rejects forged transitions', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'pregen-ok-')); let bot,journal;
 try {
  let receive; const got=new Promise(r=>receive=r);
  bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  const msg=await got, sealKey=Buffer.alloc(32,9);
  journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)}); const queue=new batches.DurableBatchCandidate(journal);
  const {session}=batches.createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
  assert.throws(()=>queue.beginGeneration(session,{}),/authorization/);
  assert.throws(()=>batches.createPreGenerationBatchCandidate({queue,bot,sealKey}),/disabled/);
  let id, sends=0;
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'},directory=path.join(dir,'store');
  initializeManagedStore(directory);
  const store=createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'});
  const gen=batches.createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async(_,identity)=>{
   id=identity.batchId; assert.throws(()=>queue.finishGeneration(session,['fake'],{}),/authorization/); return {segments:['reply'],history:await store.chatHistory(scope)};
  }});
  const row=await gen.form(session,1); assert.equal(row.id,id); assert.equal(row.state,'ready');
  bot.send=async()=>{sends++;return {ok:true,data:{status:'ok',retcode:0}}};
  const sender=batches.createBoundBatchProcessorCandidate({enabled:true,queue,bot,sealKey,ownerId:'123'});
  assert.equal((await sender.process(session)).status,'blocked'); assert.equal(sends,0);
  assert.equal((await sender.process(session,{store,scope})).status,'delivered'); assert.equal(sends,1);
 } finally {bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('mutation during generation remains blocked and cannot mint output', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'pregen-tamper-')); let bot,journal;
 try {
  let receive; const got=new Promise(r=>receive=r);
  bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  const msg=await got, sealKey=Buffer.alloc(32,9);
  journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)}); const queue=new batches.DurableBatchCandidate(journal);
  const {session}=batches.createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
  const gen=batches.createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async()=>{
   const rows=structuredClone(journal.rows); rows[0].destination='private:999'; journal.save(rows); return ['reply'];
  }});
  await assert.rejects(gen.form(session,1),/authorization/);
  await assert.rejects(gen.form(session,1),/blocked/);
 } finally {bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('stable identity reaches separate tool journal before effect, restart blocks generation', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'pregen-tool-')); let bot,journal,toolJournal;
 try {
  let receive; const got=new Promise(r=>receive=r);
  bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'fixture'}}]}));
  const msg=await got, sealKey=Buffer.alloc(32,9), key=Buffer.alloc(32,8);
  fs.mkdirSync(path.join(dir,'batch'),{mode:0o700}); fs.mkdirSync(path.join(dir,'tool'),{mode:0o700});
  journal=new EncryptedChatJournal({directory:path.join(dir,'batch'),key});
  toolJournal=new EncryptedChatJournal({directory:path.join(dir,'tool'),key:Buffer.alloc(32,7)});
  let queue=new batches.DurableBatchCandidate(journal), effects=0, generations=0;
  const {session}=batches.createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
  const tool=createDurableToolEffects({enabled:true,journal:toolJournal,tools:{fixture:async args=>{effects++; assert.equal(queue.list(session)[0].id,args.batchId); return {status:'completed',result:'ok'};}}});
  const gen=batches.createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async(_,identity)=>{
   generations++; await tool.execute({session,turn:identity.batchId,call:'0',tool:'fixture',args:identity}); throw Error('lost generation');
  }});
  await assert.rejects(gen.form(session,1),/lost generation/);
  const id=queue.list(session)[0].id; assert.equal(toolJournal.rows[0].turn,id);
  journal.close(); journal=new EncryptedChatJournal({directory:path.join(dir,'batch'),key}); queue=new batches.DurableBatchCandidate(journal);
  const replay=batches.createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async()=>{generations++;return ['bad']}});
  await assert.rejects(replay.form(session,1),/blocked/); assert.equal(generations,1); assert.equal(effects,1);
 } finally {bot?.close();journal?.close();toolJournal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
