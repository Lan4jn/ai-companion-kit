import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as runtime from '../src/chat-durable-runtime-candidate.js';
const { openDurableChatCandidate } = runtime;

function fixture() {
  const base=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'chat-key-life-'));
  const directory=path.join(base,'journal'); fs.mkdirSync(directory,{mode:0o700});
  return {base,directory,keyPath:path.join(base,'key')};
}
test('key initialization creates private random key once, refuses replacement', () => {
  const f=fixture();
  try {
    assert.equal(typeof runtime.initializeDurableChatKey,'function');
    runtime.initializeDurableChatKey(f.keyPath, {directory:f.directory});
    const first=fs.readFileSync(f.keyPath);
    assert.equal(first.length,32); assert.equal(fs.statSync(f.keyPath).mode & 0o777,0o600);
    assert.throws(()=>runtime.initializeDurableChatKey(f.keyPath,{directory:f.directory}));
    assert.deepEqual(fs.readFileSync(f.keyPath),first);
    const q=openDurableChatCandidate({...f,run:async()=>({ok:true})}); q.add('a',{synthetic:true}); q.close();
    const reopened=openDurableChatCandidate({...f,run:async()=>({ok:true})}); assert.equal(reopened.list('a').length,1); reopened.close();
  } finally {fs.rmSync(f.base,{recursive:true,force:true});}
});
test('key initialization rejects symlink target and writable ancestors', () => {
  const f=fixture();
  try {
    const missing=path.join(f.base,'missing'); fs.symlinkSync(missing,f.keyPath);
    assert.throws(()=>runtime.initializeDurableChatKey(f.keyPath,{directory:f.directory}));
    assert.equal(fs.existsSync(missing),false);
    fs.unlinkSync(f.keyPath); fs.chmodSync(f.base,0o777);
    assert.throws(()=>runtime.initializeDurableChatKey(f.keyPath,{directory:f.directory}),/unsafe key directory/);
    assert.equal(fs.existsSync(f.keyPath),false);
  } finally { fs.chmodSync(f.base,0o700); fs.rmSync(f.base,{recursive:true,force:true}); }
});
test('contradictory partial success remains unknown after restart and blocks same session only', async () => {
  const f=fixture(); fs.writeFileSync(f.keyPath,Buffer.alloc(32,5),{mode:0o600});
  try {
    let q=openDurableChatCandidate({...f,run:async()=>({ok:true,outcome:'partial'})});
    q.add('a',{n:1}); q.add('a',{n:2}); q.add('b',{n:3});
    assert.equal(await q.process('a'),false); q.close();
    let calls=0; q=openDurableChatCandidate({...f,run:async()=>{calls++;return {ok:true};}});
    assert.equal(await q.process('a'),false); assert.equal(await q.process('b'),true);
    assert.equal(calls,1); assert.deepEqual(q.list('a').map(r=>r.state),['unknown','queued']); q.close();
  } finally {fs.rmSync(f.base,{recursive:true,force:true});}
});
