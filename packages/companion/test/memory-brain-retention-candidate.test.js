import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('expired records are removed before recall using configured retention', async t => {
 const dir=mkdtempSync(join(tmpdir(),'mb-expire-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const ctx={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
 // Synthetic fixture: grant only this isolated scope/source and recall operation.
 const recoveryAuthorization=(scope,op,source)=>JSON.stringify(scope)===JSON.stringify(ctx) && op==='recall' && source==='chat';
 const b=createMemoryBrain({enabled:true,directory:dir,authorize:()=>true,recoveryAuthorization,retentionMs:10});
 await b.remember(ctx,{text:'apple expires',source:'chat',evidence:'1'});
 await new Promise(r=>setTimeout(r,30));
 assert.deepEqual(await b.recall(ctx,{query:'apple',sources:['chat']}),[]);
});

test('retention allows a fresh authorized memory and refuses an ungranted source', async t => {
 const dir=mkdtempSync(join(tmpdir(),'mb-retention-grant-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const ctx={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
 const grants=[];
 const b=createMemoryBrain({enabled:true,directory:dir,authorize:()=>true,retentionMs:60000,
  recoveryAuthorization:(scope,op,source)=>{grants.push({scope,op,source}); return JSON.stringify(scope)===JSON.stringify(ctx) && op==='recall' && source==='chat';}});
 await b.remember(ctx,{text:'apple fresh',source:'chat',evidence:'fresh'});
 assert.equal((await b.recall(ctx,{query:'apple',sources:['chat']})).length,1);
 await assert.rejects(b.recall(ctx,{query:'apple',sources:['other']}),/recovery authorization required/);
 assert.deepEqual(grants.map(g=>[g.op,g.source]),[['recall','chat'],['recall','other']]);
});

test('candidate ranking authorizes every exact source before invoking engine', async t => {
 const dir=mkdtempSync(join(tmpdir(),'mb-source-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const seen=[]; const b=createMemoryBrain({enabled:true,directory:dir,authorize:(_c,op,source)=>{seen.push([op,source]); return source !== 'denied';}});
 const ctx={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
 await assert.rejects(b.rankCandidates(ctx,{query:'apple',candidates:[{text:'apple',source:'denied',evidence:'1'}]}));
 assert.ok(seen.some(([op,source])=>op==='rankCandidates' && source==='denied'));
});

test('revocation deletes one source and persists across adapter instances', async t => {
 const dir=mkdtempSync(join(tmpdir(),'mb-revoke-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const ctx={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
 // Synthetic operator grant is scoped; it does not bypass revocation checks.
 const recoveryAuthorization=(scope,op,source)=>JSON.stringify(scope)===JSON.stringify(ctx) && op==='recall' && ['one','two'].includes(source);
 const opts={enabled:true,directory:dir,authorize:()=>true,recoveryAuthorization};
 const b=createMemoryBrain(opts);
 await b.remember(ctx,{text:'apple one',source:'one',evidence:'1'});
 await b.remember(ctx,{text:'apple two',source:'two',evidence:'2'});
 await b.revoke(ctx,{source:'one'});
 const reopened=createMemoryBrain(opts);
 await assert.rejects(reopened.remember(ctx,{text:'apple new',source:'one',evidence:'3'}));
 await assert.rejects(reopened.recall(ctx,{query:'apple',sources:['one']}));
 assert.equal((await reopened.recall(ctx,{query:'apple',sources:['two']})).length,1);
});
