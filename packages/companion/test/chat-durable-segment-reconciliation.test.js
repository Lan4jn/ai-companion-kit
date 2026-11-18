import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHmac,createHash} from 'node:crypto';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {inspectBoundBatch, reconcileBoundSegment} from '../src/chat-durable-offline-recovery.js';

test('signed segment reconciliation needs scope, snapshot and explicit resume; final acknowledgement keeps history',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'reconcile-segment-')); let j;
 try {
  j=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,31)});
  const key=createHmac('sha256',j.key).update('main-local-onebot-seal-v1').digest();
  const h=(domain,data)=>createHmac('sha256',key).update(domain+'\0').update(JSON.stringify(data)).digest('hex');
  const message={transport:'onebot-qq',conversation:'private:123',sender:'123',messageId:'1',text:'synthetic question'};
  const session='transport-bound-v1:'+createHash('sha256').update(JSON.stringify([message.transport,message.conversation])).digest('hex');
  const input={kind:'transport-bound-v1',message,tag:h('companion-transport-bound-v1',message)};
  const row={kind:'batch-candidate-v1',version:1,type:'batch',id:'fixture',session,state:'unknown',inputIds:['input'],inputs:[input],destination:'private:123',segments:['first','second'],index:0,attempt:'attempt'};
  row.history={version:1,commitments:[]};
  row.outputTags=row.segments.map((s,i)=>h('companion-generated-batch-v1',[row.id,row.session,row.inputIds,row.inputs,row.destination,row.segments,i,s,row.history]));
  row.positionTag=h('companion-batch-position-v1',[row.id,row.session,row.state,row.attempt,row.index,row.outputTags]);
  j.save([row]);
  const view=inspectBoundBatch(j,'fixture','123'); assert.deepEqual(view.segments.map(s=>s.status),['unknown','not-attempted']);
  assert.throws(()=>inspectBoundBatch(j,'fixture','456'));
  assert.throws(()=>reconcileBoundSegment(j,{id:'fixture',ownerId:'123',snapshot:view.snapshot,decision:'not-delivered'}));
  assert.throws(()=>reconcileBoundSegment(j,{id:'fixture',ownerId:'123',snapshot:view.snapshot,decision:'not-delivered',authorizeResume:true}));
  assert.equal(j.rows[0].state,'unknown');
  reconcileBoundSegment(j,{id:'fixture',ownerId:'123',snapshot:view.snapshot,decision:'delivered',authorizeResume:true});
  assert.equal(j.rows[0].state,'ready'); assert.equal(j.rows[0].index,1); assert.ok(j.rows[0].resumeTag);
  assert.throws(()=>reconcileBoundSegment(j,{id:'fixture',ownerId:'123',snapshot:view.snapshot,decision:'delivered',authorizeResume:true}));
  const broken=structuredClone(j.rows); broken[0].segments[1]='tampered'; j.save(broken); assert.throws(()=>inspectBoundBatch(j,'fixture','123'),/binding/);
  const restored=structuredClone(broken); restored[0].segments[1]='second'; j.save(restored);
  const retry=structuredClone(j.rows); retry[0].state='unknown'; retry[0].attempt='second-attempt'; retry[0].index=1; retry[0].positionTag=h('companion-batch-position-v1',[retry[0].id,retry[0].session,retry[0].state,retry[0].attempt,retry[0].index,retry[0].outputTags]); j.save(retry);
  const last=inspectBoundBatch(j,'fixture','123'); reconcileBoundSegment(j,{id:'fixture',ownerId:'123',snapshot:last.snapshot,decision:'delivered',authorizeResume:true});
  assert.equal(j.rows[0].state,'history-pending'); assert.ok(j.rows[0].ackTag); assert.deepEqual(inspectBoundBatch(j,'fixture','123').segments.map(s=>s.status),['confirmed-delivered','confirmed-delivered']);
 } finally {j?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
