import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';

test('a fabricated evidence string cannot authorize removal of an unknown message',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-auth-'));
 try { const j=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,7)}); const id=j.append('a',{text:'synthetic'}); j.claim('a'); assert.throws(()=>j.resolve('a',id,'delivered','verified receipt')); assert.equal(j.list('a')[0].state,'unknown'); } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('dangling journal symlink is rejected',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-symlink-')); const target=path.join(dir,'missing');
 try {fs.symlinkSync(target,path.join(dir,'journal.enc')); assert.throws(()=>new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,7)}),/unsafe/i);} finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('a second journal cannot use the same directory while the first is open',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'journal-lock-')); const key=Buffer.alloc(32,7);
 try { const j=new EncryptedChatJournal({directory:dir,key}); assert.throws(()=>new EncryptedChatJournal({directory:dir,key}),/lock/i);
  const moduleUrl=new URL('../src/chat-durable-journal-candidate.js',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {EncryptedChatJournal} from ${JSON.stringify(moduleUrl)}; try { new EncryptedChatJournal({directory:process.argv[1],key:Buffer.alloc(32,7)}); process.exit(3); } catch(e) { if(!/lock/i.test(e.message)) process.exit(4); }`,dir]);
  assert.equal(child.status,0,child.stderr.toString());
  j.close(); assert.throws(()=>j.list('a'),/closed/i); const next=new EncryptedChatJournal({directory:dir,key}); next.close(); } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
