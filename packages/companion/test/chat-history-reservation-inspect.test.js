import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
import {createHash,createHmac} from 'node:crypto';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {inspectReservationBatch} from '../src/chat-durable-offline-recovery.js';

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:123',user:'123'};
const make=(directory,backend='sqlite-fts')=>createMemoryBrain({enabled:true,backend,directory,authorize:async()=>true,recoveryAuthorization:async()=>true,maxChatHistoryTurns:1});
test('offline reservation diagnostic is read-only and never invents delivery evidence',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'reservation-inspect-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=make(path.join(dir,'db'));
 const turn={turnId:'one',events:['onebot-message:1'],text:'secret body',reply:'secret reply'};
 await store.reserveChatHistory(scope,turn);
 const result=await store.inspectChatHistoryReservations(scope);
 assert.equal(result.reservations.length,1);
 assert.match(result.reservations[0].turnHash,/^[a-f0-9]{64}$/);
 assert.match(result.reservations[0].payloadHash,/^[a-f0-9]{64}$/);
 assert.equal(result.reservations[0].delivery,'unverified');
 assert.doesNotMatch(JSON.stringify(result),/secret body|secret reply/);
 await assert.rejects(store.reserveChatHistory(scope,{...turn,turnId:'two'}));
 await assert.rejects(make(path.join(dir,'legacy'),'legacy').inspectChatHistoryReservations(scope),/reservation unavailable/);
});

test('signed ready batch correlates to exactly one stored reservation without exposing text',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'reservation-match-'));
 const journalDir=path.join(dir,'journal');fs.mkdirSync(journalDir,{mode:0o700});
 const j=new EncryptedChatJournal({directory:journalDir,key:Buffer.alloc(32,8)});t.after(()=>{j.close();fs.rmSync(dir,{recursive:true,force:true});});
 const seal=createHmac('sha256',j.key).update('main-local-onebot-seal-v1').digest();
 const h=(domain,data)=>createHmac('sha256',seal).update(domain+'\0').update(JSON.stringify(data)).digest('hex');
 const m={transport:'onebot-qq',conversation:scope.session,sender:scope.user,messageId:'1',text:'secret body'};
 const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([m.transport,m.conversation])).digest('hex');
 const row={kind:'batch-candidate-v1',version:1,type:'batch',id:'one',session,state:'ready',inputIds:['input'],inputs:[{kind:'transport-bound-v1',message:m,tag:h('companion-transport-bound-v1',m)}],destination:scope.session,segments:['secret reply'],index:0,attempt:null};
 row.outputTags=[h('companion-generated-batch-v1',[row.id,row.session,row.inputIds,row.inputs,row.destination,row.segments,0,row.segments[0]])];
 row.positionTag=h('companion-batch-position-v1',[row.id,row.session,row.state,row.attempt,row.index,row.outputTags]);j.save([row]);
 const store=make(path.join(dir,'db')); await store.reserveChatHistory(scope,{turnId:'one',events:['onebot-message:1'],text:'secret body',reply:'secret reply'});
 const result=await inspectReservationBatch(j,{id:'one',ownerId:'123',scope,store});
 assert.equal(result.reservation,'matched'); assert.equal(result.delivery,'journal-not-attempted'); assert.doesNotMatch(JSON.stringify(result),/secret/);
 const racingStore={async inspectChatHistoryReservations(s){ const observed=await store.inspectChatHistoryReservations(s); j.rows[0].positionTag='0'.repeat(64); return observed; }};
 await assert.rejects(inspectReservationBatch(j,{id:'one',ownerId:'123',scope,store:racingStore}),/binding mismatch|journal changed/);
 await assert.rejects(inspectReservationBatch(j,{id:'one',ownerId:'123',scope,store}),/binding mismatch/);
});
