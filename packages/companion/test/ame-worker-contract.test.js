import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

const python=process.env.AME_TEST_PYTHON;
test('AME adapter preserves scoped history, tombstones, candidate filtering and revocation', {skip:!python}, async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ame-contract-'));
 const a={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
 const b={...a,session:'private:2',user:'2'};
 const store=createMemoryBrain({enabled:true,backend:'ame',directory,python,authorize:async c=>c.user==='1',recoveryAuthorization:async()=>true});
 const source='qq-private-message', record={source,evidence:'onebot-message:1',text:'synthetic apple'};
 try {
  await store.remember(a,record);
  assert.equal((await store.recall(a,{query:'apple',sources:[source]}))[0].evidence,record.evidence);
  await assert.rejects(store.remember(b,record),/denied/);
  assert.equal((await store.privateHistory(a)).length,1);
  const turn={turnId:'turn1',events:[record.evidence],text:'synthetic apple',reply:'synthetic reply'};
  assert.equal(await store.commitChatHistory(a,turn),'inserted');
  assert.equal(await store.commitChatHistory(a,turn),'duplicate');
  assert.equal((await store.chatHistory(a)).length,1);
  assert.deepEqual(await store.filterCandidates(a,{candidates:[record]}),[0]);
  const reopened=createMemoryBrain({enabled:true,backend:'ame',directory,python,authorize:async c=>c.user==='1',recoveryAuthorization:async()=>true});
  assert.equal((await reopened.recall(a,{query:'apple',sources:[source]}))[0].evidence,record.evidence);
  await assert.rejects(reopened.recall(b,{query:'apple',sources:[source]}),/denied/);
  assert.equal((await store.rankCandidates(a,{query:'apple',candidates:[record]})).length,1);
  await store.forget(a,{source,evidence:record.evidence});
  assert.deepEqual(await store.chatHistory(a),[]);
  assert.deepEqual(await store.recall(a,{query:'apple',sources:[source]}),[]);
  assert.deepEqual(await store.filterCandidates(a,{candidates:[record]}),[]);
  assert.equal(await store.commitChatHistory(a,turn),'forgotten');
  await assert.rejects(store.remember(a,record));
  await store.revoke(a,{source});
  await assert.rejects(store.recall(a,{query:'apple',sources:[source]}));
 } finally {rmSync(directory,{recursive:true,force:true});}
});
