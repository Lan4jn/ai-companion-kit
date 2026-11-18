import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createDurableOwnerChatQueue,createTransportBoundMessageCandidate} from '../src/chat-durable-batch-candidate.js';
import {Waker} from '../src/wake.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('concurrent redelivery including the same event object runs once',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'dedupe-concurrent-')); let bot,journal,queue;
 try {
  const incoming=[]; bot=new OneBot({wsUrl:'ws://fixture',onMessage:m=>incoming.push(m)}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  const event={post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic'}}]};
  bot.ws.emit('message',JSON.stringify(event)); bot.ws.emit('message',JSON.stringify(event));
  while(incoming.length<2) await new Promise(r=>setTimeout(r,1));
  journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)}); const store=new DurableBatchCandidate(journal); let calls=0;
  queue=createDurableOwnerChatQueue({enabled:true,store,bot,sealKey:Buffer.alloc(32,9),ownerId:'123',waker:new Waker(),run:async items=>{calls++;assert.equal(items.length,1);return {ok:true};}});
  const results=await Promise.all([incoming[0],incoming[0],incoming[1]].map(msg=>Promise.resolve().then(()=>queue.add('private:123',msg,10000))));
  assert.deepEqual(results,[true,true,true]); assert.equal(journal.rows.length,1); assert.equal(journal.receipts.length,1);
  queue.flush('private:123'); await queue.drain(); assert.equal(calls,1); assert.equal(journal.receipts[0].state,'delivered');
 } finally {queue?.stop();bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
});


test('fsync failures poison the journal; reopening reflects the actual atomic rename',async()=>{
 for (const failAt of [1,2]) {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'dedupe-fsync-')); let bot,journal;
  const original=fs.fsyncSync;
  try {
   let receive; const incoming=new Promise(r=>receive=r);
   bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
   while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
   bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic'}}]}));
   const msg=await incoming, key=Buffer.alloc(32,8), sealKey=Buffer.alloc(32,9);
   journal=new EncryptedChatJournal({directory:dir,key}); let store=new DurableBatchCandidate(journal);
   let bridge=createTransportBoundMessageCandidate({enabled:true,queue:store,bot,sealKey});
   let count=0; fs.fsyncSync=(fd)=>{if(++count===failAt) throw Error('synthetic fsync failure'); return original(fd);};
   assert.throws(()=>bridge.accept(msg),/synthetic fsync failure/); fs.fsyncSync=original;
   assert.throws(()=>bridge.accept(msg),/closed or failed/);
   journal.close(); journal=new EncryptedChatJournal({directory:dir,key}); store=new DurableBatchCandidate(journal);
   bridge=createTransportBoundMessageCandidate({enabled:true,queue:store,bot,sealKey});
   const result=bridge.accept(msg); assert.equal(result.duplicate,failAt===2);
   assert.equal(store.list(result.session).length,1); assert.equal(journal.receipts.length,1);
  } finally {fs.fsyncSync=original;bot?.close();journal?.close();fs.rmSync(dir,{recursive:true,force:true});}
 }
});
