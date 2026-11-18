import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate, createDurableOwnerChatQueue} from '../src/chat-durable-batch-candidate.js';
import {Waker} from '../src/wake.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('owner parser messages traverse real batching and durable claim, unknown never replays', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'integrated-chat-')); const key=Buffer.alloc(32,11), sealKey=Buffer.alloc(32,12); let bot,journal;
 try {
  const incoming=[]; bot=new OneBot({wsUrl:'ws://fixture',onMessage:m=>incoming.push(m)}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  const emit=(uid,id,text)=>bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:uid,message_id:id,message:[{type:'text',data:{text}}]}));
  emit(123,1,'one'); emit(123,2,'two'); emit(999,3,'other');
  while(incoming.length<3) await new Promise(r=>setTimeout(r,1));
  journal=new EncryptedChatJournal({directory:dir,key}); const store=new DurableBatchCandidate(journal); let calls=0;
  assert.throws(()=>createDurableOwnerChatQueue({store,bot,sealKey,ownerId:'123',waker:new Waker(),run:async()=>({ok:true})}),/disabled/);
  const queue=createDurableOwnerChatQueue({enabled:true,store,bot,sealKey,ownerId:'123',waker:new Waker(),run:async items=>{calls++; assert.deepEqual(items.map(x=>x.text),['one','two']); assert.equal(journal.rows[0].state,'unknown'); return {ok:false,outcome:'unknown'};}});
  assert.throws(()=>queue.add('private:123',{...incoming[0]},10000),/untrusted/);
  assert.throws(()=>queue.add('private:999',incoming[2],10000),/owner/);
  assert.equal(queue.add('private:123',incoming[0],10000),true); assert.equal(queue.add('private:123',incoming[0],10000),true); assert.equal(queue.add('private:123',incoming[1],10000),true);
  assert.equal(journal.rows.length,2); queue.flush('private:123'); await assert.rejects(queue.drain()); assert.equal(calls,1); assert.equal(journal.rows[0].state,'unknown');
  journal.close(); journal=new EncryptedChatJournal({directory:dir,key});
  assert.throws(()=>createDurableOwnerChatQueue({enabled:true,store:new DurableBatchCandidate(journal),bot,sealKey,ownerId:'123',waker:new Waker(),run:async()=>{calls++;}}),/reconciliation/);
  assert.equal(calls,1);
 } finally {bot?.close(); if(journal&&!journal.closed) journal.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
