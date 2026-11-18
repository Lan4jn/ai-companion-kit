import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
import {createMemoryMaintenance} from '../src/memory-brain-maintenance.js';
const context={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
test('maintenance is opt-in and never creates missing scope databases', async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mb-maint-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const brain=createMemoryBrain({enabled:true,directory,authorize:()=>true});
 const maintenance=createMemoryMaintenance({brain, scopes:[{context,source:'x'}]});
 assert.equal(await maintenance.runOnce(),false);
 assert.deepEqual(readdirSync(directory),[]);
 const enabled=createMemoryMaintenance({enabled:true,brain,scopes:[{context,source:'x'}]});
 assert.equal(await enabled.runOnce(),true);
 assert.deepEqual(readdirSync(directory),[]);
 const denied=createMemoryBrain({enabled:true,directory,authorize:()=>false});
 await assert.rejects(createMemoryMaintenance({enabled:true,brain:denied,scopes:[{context,source:'x'}]}).runOnce(), /denied/);
 assert.deepEqual(readdirSync(directory),[]);
});

test('timer is explicit, coalesces and stops', async t=>{
 let calls=0;
 const job=createMemoryMaintenance({enabled:true,intervalMs:1000,brain:{cleanup:async()=>{calls++;}},scopes:[{context,source:'x'}]});
 t.after(()=>job.stop());
 await new Promise(r=>setTimeout(r,1050)); assert.equal(calls,0);
 assert.equal(job.start(),true); assert.equal(job.start(),false);
 await new Promise(r=>setTimeout(r,1100)); await job.stop(); assert.equal(calls,1);
});

test('authorized maintenance deletes expired records and leaves other scopes intact', async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mb-maint-real-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const brain=createMemoryBrain({enabled:true,directory,authorize:()=>true,retentionMs:1000,
  recoveryAuthorization:(scope,op,source)=>JSON.stringify(scope)===JSON.stringify(context) && op==='recall' && source==='other'});
 await brain.remember(context,{text:'apple old',source:'old',evidence:'1'});
 await new Promise(r=>setTimeout(r,1100));
 const expiredCounts=[];
 const wrapped={cleanup:async (...args)=>{ const n=await brain.cleanup(...args); expiredCounts.push(n); return n; }};
 const job=createMemoryMaintenance({enabled:true,brain:wrapped,scopes:[{context,source:'old'}]});
 assert.deepEqual(await Promise.all([job.runOnce(),job.runOnce()]),[true,true]);
 assert.deepEqual(expiredCounts,[1]);
 assert.equal(await brain.cleanup(context,{source:'old'}),0);
 await brain.remember(context,{text:'pear new',source:'other',evidence:'2'});
 assert.equal((await brain.recall(context,{query:'pear',sources:['other']})).length,1);
 await job.stop(); assert.equal(await job.runOnce(),false);
});
