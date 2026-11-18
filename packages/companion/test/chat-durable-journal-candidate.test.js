import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EncryptedChatJournal } from '../src/chat-durable-journal-candidate.js';

test('durable encrypted queue isolates sessions and never retries an uncertain claim', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-journal-')); const key=Buffer.alloc(32,3);
 try {
  let j=new EncryptedChatJournal({directory:dir,key});
  const id=j.append('private:a',{text:'secret payload'});
  j.append('private:b',{text:'other'});
  assert.equal(j.claim('private:a').id,id);
  j.close(); j=new EncryptedChatJournal({directory:dir,key});
  assert.equal(j.claim('private:a'),null);
  assert.equal(j.list('private:a')[0].state,'unknown');
  assert.equal(j.claim('private:b').payload.text,'other');
  assert.throws(()=>j.resolve('private:b',id,'delivered','receipt'));
  assert.throws(()=>j.resolve('private:a',id,'safe-to-retry','receipt'));
  assert.throws(()=>j.resolve('private:a',id,'delivered',''));
  assert.throws(()=>j.resolve('private:a',id,'delivered','verified receipt'));
  assert.equal(j.list('private:a').length,1);
  assert.equal(fs.statSync(path.join(dir,'journal.enc')).mode & 0o777,0o600);
  assert.equal(fs.readFileSync(path.join(dir,'journal.enc'),'utf8').includes('secret payload'),false);
  j.close(); assert.throws(()=>new EncryptedChatJournal({directory:dir,key:Buffer.alloc(32,4)}));
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
