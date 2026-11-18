import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createTransportBoundMessageCandidate,createTrustedBatchGenerationCandidate,createPreGenerationBatchCandidate,createBoundBatchProcessorCandidate} from '../src/chat-durable-batch-candidate.js';
import {createBoundOneBotDeliveryCandidate} from '../src/chat-delivery-candidate.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
function historyStore(dir) {
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
 const directory=path.join(dir,'store'); initializeManagedStore(directory);
 return {scope,store:createManagedMemoryBrain({directory,scope,sources:['qq-private-message'],trustedProcess:true,backend:'sqlite-fts'})};
}
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('trusted generation binds every input and segment and survives reopen without rerunning generation',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bound-send-')); let bot,journal;
 try {
  let receive; const received=new Promise(r=>receive=r);
  bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open'); // Mirror a real WebSocket handshake before inbound frames.
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic'}}]}));
  const msg=await received, key=Buffer.alloc(32,8), sealKey=Buffer.alloc(32,9);
  journal=new EncryptedChatJournal({directory:dir,key}); let queue=new DurableBatchCandidate(journal);
  let ingress=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey,ownerId:'123'});
  const {session}=ingress.accept(msg); let generated=0;
  const {store,scope}=historyStore(dir);
  const generator=createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async messages=>{generated++;assert.equal(messages[0].text,'synthetic');return {segments:['first','second'],history:await store.chatHistory(scope)};}});
  await generator.form(session,1); journal.close();
  journal=new EncryptedChatJournal({directory:dir,key}); queue=new DurableBatchCandidate(journal);
  let calls=[]; bot.send=async (...args)=>{calls.push(args);return {ok:true,data:{status:'ok',retcode:0}}};
  assert.throws(()=>createBoundOneBotDeliveryCandidate({queue,bot,sealKey}),/disabled/);
  let sender=createBoundOneBotDeliveryCandidate({enabled:true,queue,bot,sealKey,ownerId:'123'});
  assert.equal((await sender.process(session)).status,'blocked');
  assert.equal((await sender.process(session,{store,scope})).status,'delivered');
  assert.equal((await sender.process(session,{store,scope})).status,'delivered');
  assert.deepEqual(calls,[['private:123','first'],['private:123','second']]); assert.deepEqual(queue.list(session),[]); assert.equal(generated,1);
 } finally {bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('tampering, legacy output and unknown attempts never send or regenerate',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bound-adversarial-')); let bot,journal;
 try {
  let receive; const received=new Promise(r=>receive=r);
  bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open'); // Mirror a real WebSocket handshake before inbound frames.
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic'}}]}));
  const msg=await received, sealKey=Buffer.alloc(32,9);
  journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)}); const queue=new DurableBatchCandidate(journal);
  const ingress=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey,ownerId:'123'}); const {session}=ingress.accept(msg);
  let generated=0, sends=0; const {store,scope}=historyStore(dir);
  const gen=createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async()=>{generated++;return {segments:['one','two'],history:await store.chatHistory(scope)}}});
  await gen.form(session,1); const original=structuredClone(journal.rows);
  bot.send=async()=>{sends++;return {ok:false}};
  const sender=createBoundOneBotDeliveryCandidate({enabled:true,queue,bot,sealKey,ownerId:'123'});
  const mutations=[r=>r.id='other',r=>r.inputIds[0]='other',r=>r.inputs[0].message.text='evil',r=>r.destination='private:999',r=>r.segments[1]='evil',r=>r.segments.reverse(),r=>r.segments.pop(),r=>r.index=1,r=>{r.state='unknown';r.attempt='faked'},r=>delete r.outputTags];
  for (const mutate of mutations) {
   const rows=structuredClone(original); mutate(rows[0]); journal.save(rows);
   let outcome; try { outcome=await sender.process(session,{store,scope}); } catch (error) { assert.match(error.message,/mismatch|invalid|unbound|blocked/); outcome={status:'blocked'}; }
   assert.equal(outcome.status,'blocked'); assert.equal(sends,0);
  }
  journal.save(structuredClone(original));
  const wrong=createBoundOneBotDeliveryCandidate({enabled:true,queue,bot,ownerId:'123',sealKey:Buffer.alloc(32,10)});
  await assert.rejects(wrong.process(session,{store,scope}),/mismatch/);
  assert.equal((await sender.process(session,{store,scope})).status,'unknown');
  assert.equal((await sender.process(session,{store,scope})).status,'blocked'); assert.equal(sends,1); assert.equal(generated,1);
  journal.save([]);
  let receiveNext; const next=new Promise(r=>receiveNext=r); bot.onMessage=receiveNext;
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:457,message:[{type:'text',data:{text:'second synthetic'}}]}));
  const legacy=ingress.accept(await next); queue.form(legacy.session,1,['forged']);
  assert.equal((await sender.process(session)).status,'blocked'); assert.equal(sends,1);
 } finally {bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('input replacement while generation awaits cannot be signed',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bound-race-')); let bot,journal;
 try {
  let receive; const received=new Promise(r=>receive=r);
  bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open'); // Mirror a real WebSocket handshake before inbound frames.
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic'}}]}));
  const msg=await received, sealKey=Buffer.alloc(32,9);
  journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)}); const queue=new DurableBatchCandidate(journal);
  const {session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
  let release; const wait=new Promise(r=>release=r);
  const gen=createTrustedBatchGenerationCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async()=>{await wait;return ['reply']}});
  const pending=gen.form(session,1); const rows=structuredClone(journal.rows); rows[0].id='replacement';journal.save(rows);release();
  await assert.rejects(pending,/authorization mismatch/); assert.equal(queue.list(session)[0].type,'input');
 } finally {bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('signed dependency tampering and unguarded recovery fail closed',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bound-deps-')); let bot,journal;
 try {
  let receive;const received=new Promise(r=>receive=r);bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});bot.api=async()=>({ok:false});while(!bot.ws)await new Promise(r=>setTimeout(r,1));bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'new input'}}]}));
  const msg=await received,sealKey=Buffer.alloc(32,9);journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)});const queue=new DurableBatchCandidate(journal);
  const {session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
  const gen=createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async()=>({segments:['reply'],history:[{turnId:'old',events:['onebot-message:1'],text:'historical unique body',reply:'past'}]})});await gen.form(session,1);
  let sends=0;bot.send=async()=>{sends++;return {ok:true,data:{status:'ok',retcode:0}}};
  const sender=createBoundBatchProcessorCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',requireHistoryProvenance:true});const initial=structuredClone(journal.rows);
  assert.doesNotMatch(JSON.stringify(initial),/historical unique body/);assert.equal((await sender.process(session)).status,'blocked');
  for(const mutate of [r=>r.history.commitments.pop(),r=>r.history.version=2,r=>r.history.commitments[0]='0'.repeat(64),r=>r.history=[]]){const rows=structuredClone(initial);mutate(rows[0]);journal.save(rows);await assert.rejects(sender.process(session,{store:{},scope:{}}));assert.equal(sends,0);}
 }finally{bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
