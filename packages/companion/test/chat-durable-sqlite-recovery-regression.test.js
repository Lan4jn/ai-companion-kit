import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHmac,createHash} from 'node:crypto';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createBoundBatchProcessorCandidate} from '../src/chat-durable-batch-candidate.js';
import {inspectBoundBatch,reconcileBoundSegment} from '../src/chat-durable-offline-recovery.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {Memory} from '../src/memory.js';

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
test('offline reconciled segments survive restart and commit only once without sending',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'offline-history-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'store'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});
 const journalKey=Buffer.alloc(32,31); fs.mkdirSync(path.join(dir,'journal'),{mode:0o700}); let j=new EncryptedChatJournal({directory:path.join(dir,'journal'),key:journalKey});
 const sealKey=createHmac('sha256',j.key).update('main-local-onebot-seal-v1').digest();
 const h=(domain,data)=>createHmac('sha256',sealKey).update(domain+'\0').update(JSON.stringify(data)).digest('hex');
 const message={transport:'onebot-qq',conversation:scope.session,sender:'123',messageId:'1',text:'synthetic question'};
 const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([message.transport,message.conversation])).digest('hex');
 const input={kind:'transport-bound-v1',message,tag:h('companion-transport-bound-v1',message)};
 const row={kind:'batch-candidate-v1',version:1,type:'batch',id:'fixture',session,state:'unknown',inputIds:['input'],inputs:[input],destination:scope.session,segments:['first','second'],index:0,attempt:'attempt'};
 row.history={version:1,commitments:[]};
 row.outputTags=row.segments.map((s,i)=>h('companion-generated-batch-v1',[row.id,row.session,row.inputIds,row.inputs,row.destination,row.segments,i,s,row.history]));
 row.positionTag=h('companion-batch-position-v1',[row.id,row.session,row.state,row.attempt,row.index,row.outputTags]); j.save([row]);
 let sends=0; const sender={send:async()=>{sends++;return {ok:true,data:{status:'ok',retcode:0}};}};
 let queue=new DurableBatchCandidate(j), delivery=createBoundBatchProcessorCandidate({enabled:true,queue,bot:{},sender,sealKey,ownerId:'123',retainAcknowledged:true});
 assert.equal((await delivery.process(session)).status,'blocked'); assert.equal(sends,0);
 let view=inspectBoundBatch(j,'fixture','123'); reconcileBoundSegment(j,{id:'fixture',ownerId:'123',snapshot:view.snapshot,decision:'delivered',authorizeResume:true});
 assert.equal(j.rows[0].index,1);
 // Emulate the next uncertain network effect, preserving the authenticated progress marker.
 const next=structuredClone(j.rows); next[0].state='unknown';next[0].attempt='attempt-2';
 next[0].positionTag=h('companion-batch-position-v1',[next[0].id,next[0].session,next[0].state,next[0].attempt,next[0].index,next[0].outputTags]);j.save(next);
 view=inspectBoundBatch(j,'fixture','123');reconcileBoundSegment(j,{id:'fixture',ownerId:'123',snapshot:view.snapshot,decision:'delivered',authorizeResume:true});
 j.close(); j=new EncryptedChatJournal({directory:path.join(dir,'journal'),key:journalKey});
 queue=new DurableBatchCandidate(j);delivery=createBoundBatchProcessorCandidate({enabled:true,queue,bot:{},sender,sealKey,ownerId:'123',retainAcknowledged:true});
 const memory=new Memory({dir:path.join(dir,'memory')});
 assert.equal((await delivery.process(session)).status,'blocked');
 assert.equal(await delivery.recordHistory(session,memory,{store,scope}),'inserted');
 assert.deepEqual(await store.chatHistory(scope),[{turnId:'fixture',events:['onebot-message:1'],text:'synthetic question',reply:'firstsecond'}]);
 assert.equal(queue.list(session).length,0);assert.equal(sends,0);j.close();
});

test('history idempotency conflicts and forgotten evidence remain fail closed',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'history-conflict-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const directory=path.join(dir,'store');initializeManagedStore(directory);
 const store=createManagedMemoryBrain({backend:'sqlite-fts',directory,scope,sources:['qq-private-message'],trustedProcess:true});
 const turn={turnId:'one',events:['onebot-message:1'],text:'question',reply:'answer'};
 assert.equal(await store.commitChatHistory(scope,turn),'inserted');
 await assert.rejects(store.commitChatHistory(scope,{...turn,reply:'other'}),/unavailable/);
 await assert.rejects(store.commitChatHistory(scope,{...turn,turnId:'other'}),/unavailable/);
 assert.deepEqual(await store.chatHistory(scope),[turn]);
 await store.forget(scope,{source:'qq-private-message',evidence:turn.events[0]});
 assert.equal(await store.commitChatHistory(scope,turn),'forgotten');assert.deepEqual(await store.chatHistory(scope),[]);
 await store.revoke(scope,{source:'qq-private-message'});
 await assert.rejects(store.commitChatHistory(scope,{...turn,turnId:'new',events:['onebot-message:2']}),/unavailable/);
 await assert.rejects(store.chatHistory(scope),/unavailable/);
});
