import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {EncryptedChatJournal} from '../src/chat-durable-journal-candidate.js';
import {DurableBatchCandidate} from '../src/chat-durable-batch-candidate.js';

test('CLI requires explicit segment confirmation and cannot disclose message data',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'offline-cli-')); const data=path.join(dir,'data'); fs.mkdirSync(data,{mode:0o700}); const key=path.join(dir,'key'); fs.writeFileSync(key,Buffer.alloc(32,22),{mode:0o600}); let j;
 try {
  j=new EncryptedChatJournal({directory:data,key:Buffer.alloc(32,22)}); const q=new DurableBatchCandidate(j); q.accept('private-secret',{text:'private-secret'}); q.form('private-secret',1,['private-secret','second']); q.claim('private-secret'); j.close(); j=null;
  const run=(...args)=>spawnSync(process.execPath,['scripts/chat-durable-offline.mjs',...args],{encoding:'utf8'});
  const flags=['--directory',data,'--key',key]; const report=run('inspect',...flags); assert.equal(report.status,0,report.stderr); assert(!report.stdout.includes('private-secret')); const [entry]=JSON.parse(report.stdout);
  assert.notEqual(run('ack',...flags,'--id',entry.id,'--snapshot',entry.snapshot).status,0);
  assert.equal(run('ack',...flags,'--id',entry.id,'--snapshot',entry.snapshot,'--confirm-delivered').status,0);
  assert.deepEqual(JSON.parse(run('inspect',...flags).stdout)[0].segments,['confirmed-delivered','not-attempted']);
  fs.mkdirSync(path.join(data,'.journal.lock')); assert.notEqual(run('inspect',...flags).status,0); fs.rmdirSync(path.join(data,'.journal.lock'));
  fs.writeFileSync(path.join(data,'.journal-incomplete'),'x'); assert.notEqual(run('inspect',...flags).status,0); fs.unlinkSync(path.join(data,'.journal-incomplete'));
  fs.writeFileSync(key,Buffer.alloc(32,23)); assert.notEqual(run('inspect',...flags).status,0);
 } finally {j?.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
