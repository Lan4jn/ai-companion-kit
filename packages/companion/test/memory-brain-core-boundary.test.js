import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMemoryBrain } from '../src/memory-brain-adapter.js';

const a = {tenant:'t', platform:'qq', type:'private', session:'a', user:'a'};
const b = {...a, session:'b', user:'b'};
test('authorization wait cannot mutate record or source after validation', async t => {
 const dir = mkdtempSync(join(process.env.TMPDIR, 'memory-core-'));
 t.after(() => rmSync(dir,{recursive:true,force:true}));
 let release, entered;
 const gate = new Promise(r => { release = r; });
 const started = new Promise(r => { entered = r; });
 const mb = createMemoryBrain({enabled:true,directory:dir,authorize:async()=>{entered(); await gate; return true;},recoveryAuthorization:(c,op,source)=>c.user==='a' && op==='recall' && source==='chat'});
 const record = {text:'原始苹果',source:'chat',evidence:'event-original'};
 const pending = mb.remember(a,record);
 await started;
 Object.assign(record,{text:'篡改苹果',source:'other',evidence:'event-forged'});
 release();
 await pending;
 const hits = await mb.recall(a,{query:'苹果',sources:['chat']});
 assert.equal(hits.length,1);
 assert.equal(hits[0].text,'原始苹果');
 assert.equal(hits[0].evidence,'event-original');
});
test('real engine isolates scope and source before retrieval', async () => {
 const dir = mkdtempSync(join(process.env.TMPDIR, 'memory-core-'));
 try {
  const mb = createMemoryBrain({enabled:true, directory:dir, authorize: async () => true,recoveryAuthorization:(c,op,source)=>['a','b'].includes(c.user) && op==='recall' && source==='chat'});
  await mb.remember(a,{text:'苹果是红色的',source:'chat',evidence:'event-a'});
  await mb.remember(b,{text:'苹果是绿色的',source:'chat',evidence:'event-b'});
  await mb.remember(a,{text:'苹果秘密资料',source:'other',evidence:'other-a'});
  const found = await mb.recall(a,{query:'苹果',sources:['chat']});
  assert.equal(found.length,1); assert.equal(found[0].evidence,'event-a');
  assert.equal((await mb.recall(b,{query:'苹果',sources:['chat']}))[0].evidence,'event-b');
  assert.equal(readdirSync(dir).filter(x=>x.endsWith('.sqlite3')).length,3);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('denied authorization never accesses storage', async () => {
 const dir = mkdtempSync(join(process.env.TMPDIR, 'memory-core-'));
 try {
  const mb = createMemoryBrain({enabled:true,directory:dir,authorize:async()=>false});
  await assert.rejects(mb.recall(a,{query:'苹果',sources:['chat']}));
  assert.deepEqual(readdirSync(dir),[]);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('missing dependency and legacy provenance fail closed', async () => {
 const dir = mkdtempSync(join(process.env.TMPDIR, 'memory-core-'));
 try {
  const opts = {enabled:true,directory:dir,authorize:async()=>true,recoveryAuthorization:(c,op,source)=>c.user==='a' && op==='recall' && source==='chat'};
  await assert.rejects(createMemoryBrain({...opts,python:'/not/a/python'}).recall(a,{query:'苹果',sources:['chat']}));
  const mb = createMemoryBrain(opts);
  await mb.remember(a,{text:'苹果正常记录',source:'chat',evidence:'evt'});
  const file = readdirSync(dir).find(x=>x.endsWith('.sqlite3'));
  execFileSync('/usr/bin/python3',['-c',`import sqlite3,sys\nc=sqlite3.connect(sys.argv[1]); c.execute("UPDATE memories SET meta='{}'"); c.commit()`,join(dir,file)]);
  await assert.rejects(mb.recall(a,{query:'苹果',sources:['chat']}));
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
