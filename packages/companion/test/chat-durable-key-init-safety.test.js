import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initializeDurableChatKey, openDurableChatCandidate } from '../src/chat-durable-runtime-candidate.js';

test('initialization fsync failure retains lock and forbids unsafe retry', () => {
  const base=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'chat-sync-'));
  const directory=path.join(base,'journal'); fs.mkdirSync(directory,{mode:0o700});
  const key=path.join(base,'key'), original=fs.fsyncSync;
  try {
    fs.fsyncSync=()=>{throw Error('synthetic sync failure');};
    assert.throws(()=>initializeDurableChatKey(key,{directory}),/synthetic sync failure/);
    fs.fsyncSync=original;
    assert.throws(()=>initializeDurableChatKey(key,{directory}),/lock/);
    assert.throws(()=>openDurableChatCandidate({directory,keyPath:key,run:async()=>({ok:true})}));
  } finally { fs.fsyncSync=original; fs.rmSync(base,{recursive:true,force:true}); }
});

test('orphan temporary key fails closed without creating new key', () => {
  const base=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'chat-orphan-'));
  const directory=path.join(base,'journal'); fs.mkdirSync(directory,{mode:0o700});
  const key=path.join(base,'key');
  try {
    fs.writeFileSync(path.join(base,'.chat-key-orphan'),Buffer.alloc(32),{mode:0o600});
    assert.throws(()=>initializeDurableChatKey(key,{directory}),/unfinished/);
    assert.equal(fs.existsSync(key),false);
  } finally { fs.rmSync(base,{recursive:true,force:true}); }
});

test('initialization requires a journal directory and refuses any existing content', () => {
  const base=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'chat-init-'));
  const directory=path.join(base,'journal'); fs.mkdirSync(directory,{mode:0o700});
  const key=path.join(base,'key');
  try {
    assert.throws(()=>initializeDurableChatKey(key),/directory/);
    fs.writeFileSync(path.join(directory,'journal.enc'),'existing');
    assert.throws(()=>initializeDurableChatKey(key,{directory}),/journal|empty/);
    assert.equal(fs.existsSync(key),false);
    assert.equal(fs.readFileSync(path.join(directory,'journal.enc'),'utf8'),'existing');
  } finally { fs.rmSync(base,{recursive:true,force:true}); }
});
