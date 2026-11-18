import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {register} from 'node:module';
import {OneBot} from '../src/transport-onebot.js';
import {Brain} from '../src/brain.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createTransportBoundMessageCandidate,createPreGenerationBatchCandidate,createBoundBatchProcessorCandidate} from '../src/chat-durable-batch-candidate.js';
import {createLocalDurableBrainGenerator} from '../src/chat-onebot-queue-bridge.js';
register('./memory-brain-fake-ws-loader.js',import.meta.url);

async function fixture(t, text, sendResult) {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'durable-concise-'));
 let receive; const received=new Promise(r=>receive=r);
 const bot=new OneBot({wsUrl:'ws://fixture',onMessage:receive}); bot.api=async()=>({ok:false});
 while(!bot.ws) await new Promise(r=>setTimeout(r,1));
 bot.ws.emit('open');
 bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',self_id:789,user_id:123,message_id:456,message:[{type:'text',data:{text:'synthetic'}}]}));
 const msg=await received, sealKey=Buffer.alloc(32,9);
 const journal=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,8)});
 t.after(()=>{bot.close();journal.close();fs.rmSync(dir,{recursive:true,force:true})});
 const queue=new DurableBatchCandidate(journal);
 const {session}=createTransportBoundMessageCandidate({enabled:true,queue,bot,sealKey}).accept(msg);
 const brain=new Brain({apiKey:'fixture',ownerIds:['123'],role:{buildDurablePersona:()=> 'fixture'},memory:{}});
 let generated=0,rewrites=0,regenerated=0;
 brain.generateDurableTextCandidate=async()=>{generated++;return [text]};
 brain.rewriteConciseDraft=async()=>{rewrites++;return text};
 brain.regenerateConciseDraft=async()=>{regenerated++;return text};
 brain.verifyConciseDraft=async()=>true;
 const directory=path.join(dir,'store'); initializeManagedStore(directory);
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
 const store=createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});
 const generate=createLocalDurableBrainGenerator({brain,ownerId:'123',trustLocalCard:true,history:true,store,scope});
 const generation=createPreGenerationBatchCandidate({enabled:true,queue,bot,sealKey,ownerId:'123',generate});
 const sent=[]; const sender={send:async(...args)=>{sent.push(args);return sendResult}};
 const processor=createBoundBatchProcessorCandidate({enabled:true,queue,bot,sender,sealKey,ownerId:'123',retainAcknowledged:true});
 return {session,queue,generation,processor,sent,store,scope,counts:()=>({generated,rewrites,regenerated})};
}

test('persistent generation to send allows exactly 50 code points and confirms history only on acknowledgement',async t=>{
 const f=await fixture(t,'😀'.repeat(50),{ok:true,data:{status:'ok',retcode:0}});
 await f.generation.form(f.session,1);
 await f.processor.reserveHistory(f.session,{store:f.store,scope:f.scope});
 assert.equal((await f.processor.process(f.session,{store:f.store,scope:f.scope})).status,'delivered');
 assert.deepEqual(f.sent,[['private:123','😀'.repeat(50)]]);
 assert.equal(f.queue.list(f.session)[0].state,'history-pending');
 assert.deepEqual(f.counts(),{generated:1,rewrites:0,regenerated:0});
});

test('persistent generation failure over 50 stays silent with no acknowledged history',async t=>{
 const f=await fixture(t,'长'.repeat(51),{ok:true,data:{status:'ok',retcode:0}});
 await assert.rejects(f.generation.form(f.session,1),/concise failed/);
 assert.equal((await f.processor.process(f.session)).status,'blocked');
 assert.deepEqual(f.sent,[]);
 assert.equal(f.queue.list(f.session)[0].state,'generation-unknown');
 assert.deepEqual(f.counts(),{generated:1,rewrites:5,regenerated:1});
});

test('persistent multi-bubble delivery remains ordered and bounded',async t=>{
 const f=await fixture(t,'一\n\n二\n\n三',{ok:true,data:{status:'ok',retcode:0}});
 await f.generation.form(f.session,1);
 await f.processor.reserveHistory(f.session,{store:f.store,scope:f.scope});
 for(let i=0;i<3;i++) assert.equal((await f.processor.process(f.session,{store:f.store,scope:f.scope})).status,'delivered');
 assert.deepEqual(f.sent.map(x=>x[1]),['一','二','三']);
 assert.equal(f.queue.list(f.session)[0].state,'history-pending');
});

test('persistent unknown delivery stops subsequent sends and cannot create history',async t=>{
 const f=await fixture(t,'一\n\n二',{ok:false,outcome:'unknown'});
 await f.generation.form(f.session,1);
 await f.processor.reserveHistory(f.session,{store:f.store,scope:f.scope});
 assert.equal((await f.processor.process(f.session,{store:f.store,scope:f.scope})).status,'unknown');
 assert.equal((await f.processor.process(f.session,{store:f.store,scope:f.scope})).status,'blocked');
 assert.equal(f.sent.length,1);
 assert.equal(f.queue.list(f.session)[0].state,'unknown');
 await assert.rejects(f.processor.recordHistory(f.session,{}),/history not confirmed/);
 assert.equal(f.counts().generated,1);
});
