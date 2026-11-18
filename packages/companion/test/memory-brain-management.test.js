import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMemoryManager} from '../src/memory-brain-management.js';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
import {startScopedSend, withForgetWrite} from '../src/chat-forget-coordination.js';
const context={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
test('management requires separate explicit authorization and exposes no raw data',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mb-manage-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const opts={enabled:true,directory,authorize:()=>true};
 const denied=createMemoryManager(opts);
 await assert.rejects(denied.revoke({context,source:'private-source'}));
 const manager=createMemoryManager({...opts,authorizeManagement:()=>true});
 assert.deepEqual(await manager.revoke({context,source:'private-source'}),{ok:true});
 assert.deepEqual(await manager.forget({context,source:'different',evidence:'secret'}),{ok:true});
});

test('forget timeout is explicit, does not execute later, and releases the scoped queue', async t => {
 const directory=mkdtempSync(join(process.env.TMPDIR,'mb-manage-timeout-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const opts={enabled:true,directory,authorize:()=>true,recoveryAuthorization:()=>true};
 const manager=createMemoryManager({...opts,authorizeManagement:()=>true});
 const brain=createMemoryBrain(opts);
 await brain.remember(context,{source:'private-source',evidence:'secret',text:'synthetic apple'});
 let release, started;
 const startedPromise=new Promise(r=>started=r);
 const gate=new Promise(r=>release=r);
 const active=startScopedSend(directory,context,'private-source',()=>true,async()=>{started();await gate;return {ok:true};});
 await startedPromise;
 try {
  await assert.rejects(manager.forget({context,source:'private-source',evidence:'secret'}), e => e.code === 'FORGET_LOCK_TIMEOUT' && /未完成/.test(e.message));
  const other={...context,session:'other'};
  assert.equal(await withForgetWrite(directory,other,'private-source',()=>42),42);
 } finally {release();await active;}
 // An expired forget must never run later; the same key must be usable again.
 assert.equal(await withForgetWrite(directory,context,'private-source',()=>42),42);
 assert.equal((await brain.recall(context,{query:'apple',sources:['private-source']})).length,1);
 assert.deepEqual(await manager.forget({context,source:'private-source',evidence:'secret'}),{ok:true});
 assert.equal((await brain.recall(context,{query:'apple',sources:['private-source']})).length,0);
});
