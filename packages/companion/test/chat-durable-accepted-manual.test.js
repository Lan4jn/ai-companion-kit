import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {inspectAcceptedInput,authorizeAcceptedInput,hasAuthorizedInput,inspectBoundBatch,authorizeReadyBatch,hasAuthorizedResume} from '../src/chat-durable-offline-recovery.js';
import {DurableBatchCandidate,createPreGenerationBatchCandidate} from '../src/chat-durable-batch-candidate.js';

test('manual approval is scoped to one verified accepted input and snapshot', t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'accepted-review-'));
 const key=Buffer.alloc(32,7),seal=createHmac('sha256',key).update('main-local-onebot-seal-v1').digest();
 const m={transport:'onebot-qq',conversation:'private:123',sender:'123',messageId:'1',text:'synthetic'};
 const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([m.transport,m.conversation])).digest('hex');
 const tag=createHmac('sha256',seal).update('companion-transport-bound-v1\0').update(JSON.stringify(m)).digest('hex');
 const row={kind:'batch-candidate-v1',version:1,type:'input',id:'a',session,state:'accepted',input:{kind:'transport-bound-v1',message:m,tag}};
 const j=new EncryptedChatJournal({directory:dir,key});t.after(()=>{j.close();fs.rmSync(dir,{recursive:true,force:true});});j.save([row]);
 const view=inspectAcceptedInput(j,'a','123');assert.equal(view.message.text,'synthetic');
 assert.throws(()=>authorizeAcceptedInput(j,{id:'a',ownerId:'123',snapshot:view.snapshot}));
 authorizeAcceptedInput(j,{id:'a',ownerId:'123',snapshot:view.snapshot,confirmNotGenerated:true,confirmTrustedIngress:true});
 assert.equal(hasAuthorizedInput(j,j.rows[0]),true);
 assert.throws(()=>authorizeAcceptedInput(j,{id:'a',ownerId:'123',snapshot:view.snapshot,confirmNotGenerated:true,confirmTrustedIngress:true}));
 const altered=structuredClone(j.rows[0]);altered.input.message.text='forged';assert.equal(hasAuthorizedInput(j,altered),false);
});

test('approved generation claims first, requires separate send approval, and rejects forgery',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'accepted-generate-'));
 const key=Buffer.alloc(32,8),seal=createHmac('sha256',key).update('main-local-onebot-seal-v1').digest();
 const m={transport:'onebot-qq',conversation:'private:123',sender:'123',messageId:'2',text:'fixture'};
 const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([m.transport,m.conversation])).digest('hex');
 const tag=createHmac('sha256',seal).update('companion-transport-bound-v1\0').update(JSON.stringify(m)).digest('hex');
 const row={kind:'batch-candidate-v1',version:1,type:'input',id:'b',session,state:'accepted',input:{kind:'transport-bound-v1',message:m,tag}};
 const j=new EncryptedChatJournal({directory:dir,key});t.after(()=>{j.close();fs.rmSync(dir,{recursive:true,force:true});});j.save([row]);
 assert.throws(()=>inspectAcceptedInput(j,'b','999'));
 const forged=structuredClone(row);forged.input.message.text='fake';j.save([forged]);assert.throws(()=>inspectAcceptedInput(j,'b','123'));
 j.save([row]);const view=inspectAcceptedInput(j,'b','123');authorizeAcceptedInput(j,{id:'b',ownerId:'123',snapshot:view.snapshot,confirmNotGenerated:true,confirmTrustedIngress:true});
 const queue=new DurableBatchCandidate(j);let calls=0;
 const gen=createPreGenerationBatchCandidate({enabled:true,queue,bot:{},sealKey:seal,ownerId:'123',generate:async()=>{calls++;assert.equal(queue.list(session)[0].state,'generation-unknown');return {segments:['fixture response'],history:[]};}});
 await gen.form(session,1);assert.equal(calls,1);const ready=queue.list(session)[0];assert.equal(hasAuthorizedResume(j,ready),false);
 const output=inspectBoundBatch(j,ready.id,'123');assert.throws(()=>authorizeReadyBatch(j,{id:ready.id,ownerId:'123',snapshot:output.snapshot}));
 authorizeReadyBatch(j,{id:ready.id,ownerId:'123',snapshot:output.snapshot,confirmSend:true});assert.equal(hasAuthorizedResume(j,j.rows[0]),true);
});

test('failed generation stays unknown and cannot be retried',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'accepted-failed-')),key=Buffer.alloc(32,9),seal=createHmac('sha256',key).update('main-local-onebot-seal-v1').digest();
 const m={transport:'onebot-qq',conversation:'private:123',sender:'123',messageId:'3',text:'fixture'},session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([m.transport,m.conversation])).digest('hex');
 const tag=createHmac('sha256',seal).update('companion-transport-bound-v1\0').update(JSON.stringify(m)).digest('hex');
 const j=new EncryptedChatJournal({directory:dir,key});t.after(()=>{j.close();fs.rmSync(dir,{recursive:true,force:true});});j.save([{kind:'batch-candidate-v1',version:1,type:'input',id:'c',session,state:'accepted',input:{kind:'transport-bound-v1',message:m,tag}}]);
 const v=inspectAcceptedInput(j,'c','123');authorizeAcceptedInput(j,{id:'c',ownerId:'123',snapshot:v.snapshot,confirmNotGenerated:true,confirmTrustedIngress:true});
 let calls=0;const queue=new DurableBatchCandidate(j),gen=createPreGenerationBatchCandidate({enabled:true,queue,bot:{},sealKey:seal,ownerId:'123',generate:async()=>{calls++;throw Error('uncertain');}});
 await assert.rejects(gen.form(session,1),/uncertain/);assert.equal(queue.list(session)[0].state,'generation-unknown');await assert.rejects(gen.form(session,1),/blocked/);assert.equal(calls,1);
});

test('offline CLI requires both explicit confirmations',t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'accepted-cli-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const key=Buffer.alloc(32,10),keyPath=path.join(dir,'key'),journalDir=path.join(dir,'journal');fs.writeFileSync(keyPath,key,{mode:0o600});fs.mkdirSync(journalDir,{mode:0o700});
 const seal=createHmac('sha256',key).update('main-local-onebot-seal-v1').digest(),m={transport:'onebot-qq',conversation:'private:123',sender:'123',messageId:'4',text:'synthetic'};
 const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([m.transport,m.conversation])).digest('hex');
 const tag=createHmac('sha256',seal).update('companion-transport-bound-v1\0').update(JSON.stringify(m)).digest('hex');
 let j=new EncryptedChatJournal({directory:journalDir,key});j.save([{kind:'batch-candidate-v1',version:1,type:'input',id:'d',session,state:'accepted',input:{kind:'transport-bound-v1',message:m,tag}}]);j.close();
 const common=['--directory',journalDir,'--key',keyPath,'--id','d','--owner','123'],script=path.resolve('scripts/chat-durable-offline.mjs');
 const view=JSON.parse(execFileSync(process.execPath,[script,'inspect-input',...common],{encoding:'utf8'}));
 const args=[script,'approve-input',...common,'--snapshot',view.snapshot,'--confirm-not-generated'];assert.notEqual(spawnSync(process.execPath,args).status,0);
 execFileSync(process.execPath,[...args,'--confirm-trusted-ingress']);
 j=new EncryptedChatJournal({directory:journalDir,key});assert.equal(hasAuthorizedInput(j,j.rows[0]),true);j.close();
});
