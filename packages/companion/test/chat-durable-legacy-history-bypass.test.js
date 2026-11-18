import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate,createPreGenerationBatchCandidate,createBoundBatchProcessorCandidate} from '../src/chat-durable-batch-candidate.js';
import {inspectBoundBatch,authorizeReadyBatch} from '../src/chat-durable-offline-recovery.js';

test('legacy signed output cannot gain send authority through manual approval or standalone processor',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'legacy-bypass-'));const key=Buffer.alloc(32,8),seal=createHmac('sha256',key).update('main-local-onebot-seal-v1').digest();
 const m={transport:'onebot-qq',conversation:'private:123',sender:'123',messageId:'2',text:'fixture'};
 const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([m.transport,m.conversation])).digest('hex');
 const tag=createHmac('sha256',seal).update('companion-transport-bound-v1\0').update(JSON.stringify(m)).digest('hex');
 const j=new EncryptedChatJournal({directory:dir,key});t.after(()=>{j.close();fs.rmSync(dir,{recursive:true,force:true});});j.save([{kind:'batch-candidate-v1',version:1,type:'input',id:'b',session,state:'accepted',input:{kind:'transport-bound-v1',message:m,tag}}]);
 const queue=new DurableBatchCandidate(j);await createPreGenerationBatchCandidate({enabled:true,queue,bot:{},sealKey:seal,ownerId:'123',generate:async()=>['remembered secret']}).form(session,1);
 const row=queue.list(session)[0],view=inspectBoundBatch(j,row.id,'123');
 assert.throws(()=>authorizeReadyBatch(j,{id:row.id,ownerId:'123',snapshot:view.snapshot,confirmSend:true}),/provenance/);
 let sends=0;const processor=createBoundBatchProcessorCandidate({enabled:true,queue,bot:{},sender:{send:async()=>{sends++;return {status:'ok',retcode:0,data:{message_id:1}};}},sealKey:seal,ownerId:'123'});
 assert.deepEqual(await processor.process(session),{status:'blocked'});assert.equal(sends,0);
});
