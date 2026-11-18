import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EncryptedChatJournal } from '../src/chat-durable-journal-candidate.js';
import { DurableBatchCandidate } from '../src/chat-durable-batch-candidate.js';

test('atomic batch survives restart with exact inputs and segments; unknown blocks only its session', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-candidate-')); const key=Buffer.alloc(32,7); let j;
 try {
  j=new EncryptedChatJournal({directory:dir,key}); let q=new DurableBatchCandidate(j);
  q.accept('群一',{text:'私密资料甲'}); q.accept('群一',{text:'乙'}); q.accept('群二',{text:'丙'});
  const batch=q.form('群一',2,['第一段','第二段']); q.form('群二',1,['另一群']);
  assert.deepEqual(batch.inputs.map(x=>x.text),['私密资料甲','乙']);
  assert.equal(q.claim('群一').segment,'第一段');
  j.close(); j=new EncryptedChatJournal({directory:dir,key}); q=new DurableBatchCandidate(j);
  assert.equal(q.claim('群一'),null); assert.equal(q.claim('群二').segment,'另一群');
  assert.equal(fs.readFileSync(path.join(dir,'journal.enc'),'utf8').includes('私密资料甲'),false);
 } finally {if(j&&!j.closed) j.close(); fs.rmSync(dir,{recursive:true,force:true});}
});

test('partial and stale results cannot advance segments after restart', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-outcome-')); const key=Buffer.alloc(32,8); let j;
 try {
  j=new EncryptedChatJournal({directory:dir,key}); let q=new DurableBatchCandidate(j);
  q.accept('a',{text:'one'}); q.form('a',1,['x','y']);
  const first=q.claim('a');
  assert.equal(q.complete(first,{status:'delivered',partial:true}),false);
  assert.equal(q.complete(first,{status:'partial'}),false);
  assert.equal(q.claim('a'),null);
  j.close(); j=new EncryptedChatJournal({directory:dir,key}); q=new DurableBatchCandidate(j);
  assert.equal(q.complete(first,{status:'delivered'}),false);
  assert.equal(q.claim('a'),null);
 } finally {if(j&&!j.closed) j.close(); fs.rmSync(dir,{recursive:true,force:true});}
});

test('confirmed segments advance once in order and preserve later batch order', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-order-')); let j;
 try {
  j=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,3)}); const q=new DurableBatchCandidate(j);
  q.accept('a',{text:'1'}); q.accept('a',{text:'2'}); q.form('a',1,['x','y']); q.form('a',1,['z']);
  const x=q.claim('a'); assert.equal(x.segment,'x'); assert.equal(q.complete(x,{status:'delivered'}),true);
  assert.equal(q.complete(x,{status:'delivered'}),false);
  const y=q.claim('a'); assert.equal(y.segment,'y'); assert.equal(q.complete(y,{status:'delivered'}),true);
  const z=q.claim('a'); assert.equal(z.segment,'z'); assert.equal(q.complete(z,{status:'delivered'}),true);
  assert.deepEqual(q.list('a'),[]);
 } finally {if(j&&!j.closed) j.close(); fs.rmSync(dir,{recursive:true,force:true});}
});

test('ambiguous persistence failure stops the instance and never falls back to volatile state', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'batch-fsync-')); let j;
 const original=fs.fsyncSync;
 try {
  j=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,4)}); let q=new DurableBatchCandidate(j);
  q.accept('a',{text:'keep'});
  fs.fsyncSync=()=>{ throw Error('injected sync failure'); };
  assert.throws(()=>q.form('a',1,['out']),/injected sync failure/);
  fs.fsyncSync=original;
  assert.throws(()=>q.claim('a'),/failed/);
  j.close(); j=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,4)}); q=new DurableBatchCandidate(j);
  assert.equal(q.list('a')[0].type,'input'); assert.equal(q.claim('a'),null);
 } finally {fs.fsyncSync=original; if(j&&!j.closed) j.close(); fs.rmSync(dir,{recursive:true,force:true});}
});

