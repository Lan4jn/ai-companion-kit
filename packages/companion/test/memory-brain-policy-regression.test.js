import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';
const ctx={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
const candidate={text:'apple favorite',source:'external',evidence:'one'};
test('revoked source cannot be ranked by a new adapter',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mb-policy-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const opts={enabled:true,directory,authorize:()=>true,
  recoveryAuthorization:(scope,op,source)=>JSON.stringify(scope)===JSON.stringify(ctx) && op==='rankCandidates' && source==='external'};
 await createMemoryBrain(opts).revoke(ctx,{source:'external'});
 await assert.rejects(createMemoryBrain(opts).rankCandidates(ctx,{query:'apple',candidates:[candidate]}),/memory-brain unavailable/);
});
test('restoring an older database cannot undo a revocation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mb-policy-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const opts={enabled:true,directory,authorize:()=>true};
 const b=createMemoryBrain(opts);
 await b.remember(ctx,{text:'apple',source:'chat',evidence:'one'});
 const db=join(directory,readdirSync(directory).find(x=>x.endsWith('.sqlite3')));
 const backup=readFileSync(db);
 await b.revoke(ctx,{source:'chat'});
 writeFileSync(db,backup);
 await assert.rejects(createMemoryBrain(opts).recall(ctx,{query:'apple',sources:['chat']}));
});

test('shorter retention remains binding after reopening with longer retention',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mb-policy-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const opts={enabled:true,directory,authorize:()=>true,
  recoveryAuthorization:(scope,op,source)=>JSON.stringify(scope)===JSON.stringify(ctx) && op==='recall' && source==='chat'};
 await createMemoryBrain({...opts,retentionMs:30}).remember(ctx,{text:'apple',source:'chat',evidence:'one'});
 await new Promise(r=>setTimeout(r,80));
 assert.deepEqual(await createMemoryBrain(opts).recall(ctx,{query:'apple',sources:['chat']}),[]);
});
