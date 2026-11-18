import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from '../src/chat-durable-batch-candidate.js';

function fixture(fn) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-batch-')); const key=Buffer.alloc(32,23); let j;
 try { j=new EncryptedChatJournal({directory:dir,key}); fn(j,()=>{j.close(); j=new EncryptedChatJournal({directory:dir,key}); return j;}); }
 finally {if(j&&!j.closed) j.close(); fs.rmSync(dir,{recursive:true,force:true});}
}

test('capacity counts inputs in formed batches and rejection is atomic',()=>fixture(j=>{
 const q=new DurableBatchCandidate(j,{maxInputs:2,maxInputsPerSession:1});
 q.accept('a',{text:'1'}); q.form('a',1,['x']);
 assert.throws(()=>q.accept('a',{text:'2'}),/capacity/);
 q.accept('b',{text:'3'}); assert.throws(()=>q.accept('c',{text:'4'}),/capacity/);
 assert.equal(q.list('a').length,1); assert.equal(q.list('c').length,0);
}));

test('byte caps reject large input and output without replacing accepted input',()=>fixture(j=>{
 const q=new DurableBatchCandidate(j,{maxInputBytes:20,maxSegmentBytes:8});
 assert.throws(()=>q.accept('a',{text:'x'.repeat(30)}),/capacity/);
 q.accept('a',{text:'ok'}); assert.throws(()=>q.form('a',1,['x'.repeat(9)]),/capacity/);
 assert.equal(q.list('a')[0].type,'input');
}));
