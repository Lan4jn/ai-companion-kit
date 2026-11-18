import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot, isTrustedMemoryMessage} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate, createTransportBoundMessageCandidate} from '../src/chat-durable-batch-candidate.js';
import {createBoundOneBotDeliveryCandidate} from '../src/chat-delivery-candidate.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('unsigned reopened ready segment cannot be sent', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'chat-ready-provenance-'));
 const key=Buffer.alloc(32,31), sealKey=Buffer.alloc(32,32); let bot,journal;
 try {
  let receive; const received=new Promise(resolve=>{receive=resolve});
  bot=new OneBot({wsUrl:'ws://fixture',dataDir:dir,onMessage:receive});
  bot.api=async()=>({ok:false}); // keep the fake socket entirely offline
  while (!bot.ws) await new Promise(resolve=>setTimeout(resolve,1));
  bot.ws.emit('open');
  assert.equal(bot.connected,true);
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic input'}}]}));
  let deadline;
  const message=await Promise.race([received,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('fixture message was not delivered')),1000);})]).finally(()=>clearTimeout(deadline));
  journal=new EncryptedChatJournal({directory:dir,key});
  let queue=new DurableBatchCandidate(journal);
  const ingress=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
  const {session}=ingress.accept(message);
  queue.form(session,1,['arbitrary synthetic output']);
  journal.close();
  journal=new EncryptedChatJournal({directory:dir,key});
  queue=new DurableBatchCandidate(journal);
  const reconstructed=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).reconstruct(session,queue.list(session)[0].inputs[0]);
  assert.equal(isTrustedMemoryMessage(reconstructed),false);
  const sends=[];
  bot.send=async (...args)=>{sends.push(args); return {ok:true,data:{status:'ok',retcode:0}}};
  const sender=createBoundOneBotDeliveryCandidate({enabled:true,queue,bot,sealKey,ownerId:'123'});
  assert.equal((await sender.process(session)).status,'blocked');
  assert.deepEqual(sends,[]);
  assert.equal(queue.list(session)[0].state,'ready');
 } finally {
  bot?.close();
  if (journal && !journal.closed) journal.close();
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
