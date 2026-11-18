import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot, isTrustedMemoryMessage} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from '../src/chat-durable-batch-candidate.js';
import * as candidate from '../src/chat-durable-batch-candidate.js';
register('./memory-brain-fake-ws-loader.js', import.meta.url);

test('transport-bound signed snapshots survive restart without granting event privileges', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bound-transport-'));
 const key=Buffer.alloc(32,71), sealKey=Buffer.alloc(32,72); let journal, bot;
 try {
  let done; const received=new Promise(r=>done=r);
  bot=new OneBot({wsUrl:'ws://fixture',onMessage:done}); bot.api=async()=>({ok:false});
  while(!bot.ws) await new Promise(r=>setTimeout(r,1));
  bot.ws.emit('open');
  bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'hello'}}]}));
  const msg=await received;
  journal=new EncryptedChatJournal({directory:dir,key}); let queue=new DurableBatchCandidate(journal);
  assert.throws(()=>candidate.createTransportBoundMessageCandidate({queue,bot,sealKey}),/disabled/);
  let bridge=candidate.createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
  assert.throws(()=>candidate.createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:Buffer.alloc(3)}),/key/);
  assert.throws(()=>bridge.accept({...msg}),/untrusted/);
  const {session}=bridge.accept(msg); const row=queue.list(session)[0];
  journal.close(); journal=new EncryptedChatJournal({directory:dir,key}); queue=new DurableBatchCandidate(journal);
  bridge=candidate.createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
  const recovered=bridge.reconstruct(session,row.input);
  assert.deepEqual(recovered,{transport:'onebot-qq',conversation:'private:123',sender:'123',messageId:'456',text:'hello'});
  assert.equal(isTrustedMemoryMessage(recovered),false);
  const wrong=candidate.createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey:Buffer.alloc(32,73)});
  assert.throws(()=>wrong.reconstruct(session,row.input),/mismatch/);
  assert.throws(()=>bridge.reconstruct(session,{...row.input, message:{...row.input.message,sender:'999'}}),/invalid|mismatch/);
  assert.throws(()=>bridge.reconstruct(session,{...row.input, message:{...row.input.message,text:'forged'}}),/invalid|mismatch/);
  assert.throws(()=>bridge.reconstruct('other',row.input),/invalid|mismatch/);
  msg.text='changed'; assert.throws(()=>bridge.accept(msg),/untrusted/);
 } finally {bot?.close(); if(journal&&!journal.closed) journal.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
