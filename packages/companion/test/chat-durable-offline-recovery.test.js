import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from '../src/chat-durable-batch-candidate.js';
import {inspectBatchJournal, acknowledgeDeliveredSegment} from '../src/chat-durable-offline-recovery.js';

test('offline inspection is private and acknowledgement advances only the exact unknown segment', () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'offline-chat-')); let j;
 try {
  j=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,19)}); const q=new DurableBatchCandidate(j);
  q.accept('private-secret',{text:'secret-input'}); q.form('private-secret',1,['secret-first','secret-second']); q.claim('private-secret');
  const [entry]=inspectBatchJournal(j); const output=JSON.stringify(entry);
  assert(!output.includes('secret')); assert.deepEqual(entry.segments,['unknown','not-attempted']);
  assert.throws(()=>acknowledgeDeliveredSegment(j,entry.id,'bad'),/snapshot/);
  assert.deepEqual(inspectBatchJournal(j)[0].segments,['unknown','not-attempted']);
  acknowledgeDeliveredSegment(j,entry.id,entry.snapshot);
  assert.deepEqual(inspectBatchJournal(j)[0].segments,['confirmed-delivered','not-attempted']);
  assert.throws(()=>acknowledgeDeliveredSegment(j,entry.id,entry.snapshot),/unknown|snapshot/);
  q.claim('private-secret');
  const final=inspectBatchJournal(j)[0]; assert.deepEqual(final.segments,['confirmed-delivered','unknown']);
  acknowledgeDeliveredSegment(j,final.id,final.snapshot); assert.deepEqual(inspectBatchJournal(j),[]);
 } finally {j?.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
