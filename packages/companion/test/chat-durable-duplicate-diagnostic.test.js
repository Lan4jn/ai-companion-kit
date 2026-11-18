import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createTransportBoundMessageCandidate} from '../src/chat-durable-batch-candidate.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

test('repeated OneBot message remains idempotent across journal reopen', async () => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'chat-duplicate-diagnostic-'));
  let bot, journal;
  try {
    let receive;
    bot=new OneBot({wsUrl:'ws://fixture',onMessage:msg=>receive(msg)});
    bot.api=async()=>({ok:false});
    while(!bot.ws) await new Promise(resolve=>setTimeout(resolve,1));
    bot.ws.emit('open');
    const message=async text=>{
      const got=new Promise(resolve=>{receive=resolve;});
      bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text}}]}));
      return got;
    };
    const key=Buffer.alloc(32,8), sealKey=Buffer.alloc(32,9);
    journal=new EncryptedChatJournal({directory:dir,key});
    let queue=new DurableBatchCandidate(journal);
    let ingress=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
    const first=ingress.accept(await message('synthetic'));
    const second=ingress.accept(await message('synthetic'));
    assert.equal(first.session,second.session);
    assert.equal(first.id,second.id);
    assert.equal(queue.list(first.session).length,1);
    journal.close(); bot.close();
    bot=new OneBot({wsUrl:'ws://fixture',onMessage:msg=>receive(msg)});
    bot.api=async()=>({ok:false});
    while(!bot.ws) await new Promise(resolve=>setTimeout(resolve,1));
    bot.ws.emit('open');
    journal=new EncryptedChatJournal({directory:dir,key});
    queue=new DurableBatchCandidate(journal);
    ingress=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
    const reopened=ingress.accept(await message('synthetic'));
    assert.equal(reopened.id,first.id);
    assert.equal(queue.list(first.session).length,1);
    const conflict=await message('different synthetic text');
    assert.throws(()=>ingress.accept(conflict),/conflict|mismatch/i);
    assert.equal(queue.list(first.session).length,1);
    queue.form(first.session,1,['synthetic reply']);
    const claim=queue.claim(first.session);
    assert.equal(queue.list(first.session)[0].state,'unknown');
    const blocked=ingress.accept(await message('synthetic'));
    assert.equal(blocked.id,first.id);
    assert.equal(blocked.state,'unknown');
    assert.equal(queue.list(first.session).length,1);
    assert.equal(queue.complete(claim,{status:'delivered'}),true);
    const delivered=ingress.accept(await message('synthetic'));
    assert.equal(delivered.id,first.id);
    assert.equal(delivered.state,'delivered');
    assert.equal(queue.list(first.session).length,0);
    journal.close();
    journal=new EncryptedChatJournal({directory:dir,key});
    queue=new DurableBatchCandidate(journal);
    ingress=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey});
    assert.equal(ingress.accept(await message('synthetic')).state,'delivered');
    assert.equal(queue.list(first.session).length,0);
  } finally {
    bot?.close(); journal?.close(); fs.rmSync(dir,{recursive:true,force:true});
  }
});
