import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeManagedStore,createManagedMemoryBrain,restoreManagedStore,reviewManagedStore} from '../src/memory-brain-trust.js';
const python=process.env.AME_TEST_PYTHON;
const scope={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
test('managed AME selection, concurrent writes, recovery and legacy isolation',{skip:!python,timeout:90000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'managed-ame-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const directory=join(root,'db');initializeManagedStore(directory);
 const options={directory,scope,sources:['chat'],trustedProcess:true,python};
 const ame=createManagedMemoryBrain({...options,backend:'ame'});
 // The coordination API intentionally rejects after a bounded wait. Each AME
 // operation starts a Python worker while holding the lock, so a burst may
 // legitimately exceed that wait, especially with other test files running.
 // Retry only the explicit pre-execution lock timeout; never retry unknown work.
 const retryBusy=async action=>{
  for(let attempt=0;;attempt++) {
   try { return await action(); }
   catch(error) { if(error?.code!=='FORGET_LOCK_TIMEOUT' || attempt>=20) throw error; }
  }
 };
 await Promise.all(Array.from({length:16},(_,i)=>retryBusy(()=>ame.remember(scope,{source:'chat',evidence:`e${i}`,text:`apple synthetic ${i}`}))));
 assert.equal((await ame.recall(scope,{query:'apple',sources:['chat'],limit:20})).length,16);
 await assert.rejects(ame.recall({...scope,user:'2'},{query:'apple',sources:['chat']}),/denied/);
 await assert.rejects(ame.recall(scope,{query:'apple',sources:['other']}),/denied/);
 const racing=Array.from({length:8},()=>retryBusy(()=>ame.remember(scope,{source:'chat',evidence:'race',text:'apple race'})).catch(error=>{if(error.message!=='evidence forgotten') throw error;}));
 await Promise.all([...racing,retryBusy(()=>ame.forget(scope,{source:'chat',evidence:'race'}))]);
 await assert.rejects(ame.remember(scope,{source:'chat',evidence:'race',text:'apple race'}));
 assert.equal((await ame.recall(scope,{query:'apple',sources:['chat'],limit:20})).length,16);
 assert.ok(readdirSync(directory).some(x=>x.startsWith('ame-v1-')));
 const restored=join(root,'restored');restoreManagedStore(directory,restored);
 const reader=createManagedMemoryBrain({...options,directory:restored,backend:'ame'});
 await assert.rejects(reader.recall(scope,{query:'apple',sources:['chat']}),/review/);
 reviewManagedStore(restored,'I REVIEWED ALL REVOCATIONS AND FORGETS');
 assert.equal((await reader.recall(scope,{query:'apple',sources:['chat'],limit:20})).length,16);
 assert.deepEqual(await createManagedMemoryBrain({...options,directory:restored,python:'/usr/bin/python3'}).recall(scope,{query:'apple',sources:['chat']}),[]);
});
