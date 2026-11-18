import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';

test('SIGKILL after durable claim restores unknown and blocks later same-session message',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-crash-')); const key=Buffer.alloc(32,8);
 try {
  const j=new EncryptedChatJournal({directory:dir,key}); j.append('a',{text:'first'});j.append('a',{text:'second'}); j.close();
  const moduleUrl=new URL('../src/chat-durable-journal-candidate.js',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {EncryptedChatJournal} from ${JSON.stringify(moduleUrl)}; const j=new EncryptedChatJournal({directory:process.argv[1],key:Buffer.alloc(32,8)}); j.claim('a'); process.kill(process.pid,'SIGKILL')`,dir]);
  assert.equal(child.signal,'SIGKILL');
  assert.throws(()=>new EncryptedChatJournal({directory:dir,key}),/lock/i);
  // Only this synthetic test controls and has waited for the killed process.
  fs.rmdirSync(path.join(dir,'.journal.lock'));
  const recovered=new EncryptedChatJournal({directory:dir,key}); assert.deepEqual(recovered.list('a').map(r=>r.state),['unknown','queued']); assert.equal(recovered.claim('a'),null); recovered.close();
 } finally {fs.rmSync(dir,{recursive:true,force:true})}
});

test('failed directory sync poisons instance rather than permitting stale subsequent writes',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-fsync-')); const j=new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,9)});
 const original=fs.fsyncSync; let n=0;
 try {
  fs.fsyncSync=(fd)=>{if(++n===2) throw Error('disk sync failure'); return original(fd)};
  assert.throws(()=>j.append('a',{text:'one'})); fs.fsyncSync=original;
  assert.throws(()=>j.append('b',{text:'two'}),/poison|failed/i);
 } finally {fs.fsyncSync=original;fs.rmSync(dir,{recursive:true,force:true})}
});
