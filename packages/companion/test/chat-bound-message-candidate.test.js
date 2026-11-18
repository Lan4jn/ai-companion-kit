import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from '../src/chat-durable-batch-candidate.js';
import * as candidate from '../src/chat-durable-batch-candidate.js';
const {createBoundMessageCandidate} = candidate;

test('recovery re-resolves immutable identity and content, never fabricates an event', async ()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bound-message-')); const key=Buffer.alloc(32,31); let j;
 const original={transport:'fixture',conversation:'c',sender:'s',messageId:'m',text:'hello'};
 let source={...original};
 try {
  j=new EncryptedChatJournal({directory:dir,key}); let q=new DurableBatchCandidate(j);
  let bridge=createBoundMessageCandidate({enabled:true,queue:q,resolve:async()=>source});
  const ref={transport:'fixture',conversation:'c',sender:'s',messageId:'m'};
  await bridge.accept(ref); j.close(); j=new EncryptedChatJournal({directory:dir,key}); q=new DurableBatchCandidate(j);
  bridge=createBoundMessageCandidate({enabled:true,queue:q,resolve:async()=>source});
  const session=bridge.session(ref); const row=q.list(session)[0];
  assert.deepEqual(await bridge.reconstruct(session,row.input),original);
  source={...source,sender:'other'}; await assert.rejects(bridge.reconstruct(session,row.input),/mismatch/);
  source={...original,text:'changed'}; await assert.rejects(bridge.reconstruct(session,row.input),/mismatch/);
  source={...original,role:'owner'}; await assert.rejects(bridge.reconstruct(session,row.input),/invalid/);
  await assert.rejects(bridge.reconstruct('other',row.input),/mismatch/);
 } finally {if(j&&!j.closed) j.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('bridge is disabled unless explicitly opted in',()=>{
 assert.throws(()=>createBoundMessageCandidate({resolve:async()=>null}),/disabled/);
});
