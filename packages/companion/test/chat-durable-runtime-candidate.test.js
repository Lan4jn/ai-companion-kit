import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDurableChatCandidate } from '../src/chat-durable-runtime-candidate.js';

test('private key file opens an isolated durable queue and unknown blocks replay after restart', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'chat-key-test-'));
  fs.chmodSync(dir, 0o700);
  const keyPath = path.join(dir, 'key'); fs.writeFileSync(keyPath, Buffer.alloc(32, 7), {mode:0o600});
  const journalDir = path.join(dir,'journal'); fs.mkdirSync(journalDir, {mode:0o700});
  try {
    const calls = [];
    let runtime = openDurableChatCandidate({directory:journalDir,keyPath,run:async payload => { calls.push(payload); throw Error('ambiguous'); }});
    runtime.add('s',{text:'synthetic'});
    await runtime.process('s');
    assert.equal(runtime.list('s')[0].state,'unknown');
    runtime.close();
    runtime = openDurableChatCandidate({directory:journalDir,keyPath,run:async payload => calls.push(payload)});
    await runtime.process('s');
    assert.equal(calls.length,1);
    assert.equal(runtime.list('s')[0].state,'unknown');
    runtime.close();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('rejects unsafe and symlink key files', () => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'chat-key-test-'));
  const journalDir=path.join(dir,'journal'); fs.mkdirSync(journalDir,{mode:0o700});
  const keyPath=path.join(dir,'key'); fs.writeFileSync(keyPath,Buffer.alloc(32),{mode:0o644}); fs.chmodSync(keyPath,0o644);
  const open=keyPath => openDurableChatCandidate({directory:journalDir,keyPath,run:async()=>({ok:true})});
  try {
    assert.throws(()=>open(keyPath),/unsafe key/);
    fs.chmodSync(keyPath,0o600);
    const link=path.join(dir,'link'); fs.symlinkSync(keyPath,link);
    assert.throws(()=>open(link));
    fs.writeFileSync(keyPath,Buffer.alloc(31));
    assert.throws(()=>open(keyPath),/unsafe key/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('only explicit success removes a claim; concurrent processing cannot duplicate it', async () => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'chat-key-test-'));
  const journalDir=path.join(dir,'journal'); fs.mkdirSync(journalDir,{mode:0o700});
  const keyPath=path.join(dir,'key'); fs.writeFileSync(keyPath,Buffer.alloc(32,1),{mode:0o600});
  let finish, calls=0;
  try {
    const runtime=openDurableChatCandidate({directory:journalDir,keyPath,run:()=>{calls++; return new Promise(resolve=>finish=resolve);}});
    runtime.add('s',{text:'synthetic'});
    const processing=runtime.process('s');
    assert.equal(await runtime.process('s'),false);
    assert.throws(()=>runtime.close(),/active/);
    finish({ok:true}); assert.equal(await processing,true);
    assert.equal(calls,1); assert.deepEqual(runtime.list('s'),[]);
    runtime.close();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
