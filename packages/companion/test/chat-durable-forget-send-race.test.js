import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {OneBot} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createTransportBoundMessageCandidate,createPreGenerationBatchCandidate,createBoundBatchProcessorCandidate} from '../src/chat-durable-batch-candidate.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('forget cannot complete while a reserved delivery is in flight',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-forget-send-')); let bot,journal,release;
 try {
  let receive;const got=new Promise(r=>receive=r);bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic'}}]}));
  const msg=await got,key=Buffer.alloc(32,8),sealKey=Buffer.alloc(32,9);
  journal=new EncryptedChatJournal({directory:dir,key});const queue=new DurableBatchCandidate(journal);
  const {session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
  await createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate:async()=>({segments:['reply'],history:[]})}).form(session,1);
  let entered;const started=new Promise(r=>entered=r);const gate=new Promise(r=>release=r);
  const delivery=createBoundBatchProcessorCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',retainAcknowledged:true,sender:{send:async()=>{entered();await gate;return {ok:true,data:{status:'ok',retcode:0}};}}});
  const directory=path.join(dir,'store');initializeManagedStore(directory);
  const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
  const store=createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});
  // This is the same reserved-send operation used by the main runtime.
  await delivery.reserveHistory(session,{store,scope});
  const sending=delivery.process(session,{store,scope});
  await started;
  let forgotten=false;const forgetting=store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:456'}).then(()=>{forgotten=true;});
  await new Promise(r=>setTimeout(r,250));assert.equal(forgotten,false,'forget completed before the in-flight send settled');
  release();assert.equal((await sending).status,'delivered');await forgetting;assert.equal(forgotten,true);
  // Reopen the acknowledged batch as ready is forbidden; use a second fresh
  // journal and event to test a completed forget before reservation.
  const secondDir=path.join(dir,'second');fs.mkdirSync(secondDir,{mode:0o700});
  let receive2;const got2=new Promise(r=>receive2=r);bot.onMessage=receive2;
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:457,message:[{type:'text',data:{text:'synthetic two'}}]}));
  const msg2=await got2;const j2=new EncryptedChatJournal({directory:secondDir,key});
  try {
   const q2=new DurableBatchCandidate(j2), ref=createTransportBoundMessageCandidate({enabled:true,queue:q2,bot,sealKey}).accept(msg2);
   await createPreGenerationBatchCandidate({enabled:true,queue:q2,bot,sealKey,ownerId:'123',generate:async()=>({segments:['reply'],history:[]})}).form(ref.session,1);
   let sends=0;const d2=createBoundBatchProcessorCandidate({enabled:true,queue:q2,bot,sealKey,ownerId:'123',sender:{send:async()=>{sends++;}}});
   await store.forget(scope,{source:'qq-private-message',evidence:'onebot-message:457'});
   await assert.rejects(d2.process(ref.session,{store,scope}));
   assert.equal(sends,0);assert.equal(q2.list(ref.session)[0].state,'ready');
  } finally {j2.close();}
 } finally {release?.();bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
