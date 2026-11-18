import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Memory} from '../src/memory.js';
import {startProactive, stopProactive} from '../src/proactive.js';

test('recent private activity remains observable without revealing hidden legacy content', t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'activity-barrier-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'memory-brain-scoped'));
 const memory=new Memory({dir});
 const before=Date.now();
 memory.logTurn({where:'private:123',who:'123',text:'synthetic private',reply:'synthetic reply'});
 assert.deepEqual(memory.sessionTurns('private:123'),[]);
 assert.ok(memory.sessionLastActivity('private:123') >= before);
 assert.equal(memory.sessionLastActivity('private:456'),0);
});

test('proactive scheduling respects hidden activity', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'activity-proactive-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'memory-brain-scoped'));
 const memory=new Memory({dir});
 memory.logTurn({where:'private:123',who:'123',text:'synthetic',reply:'reply'});
 const originalSetTimeout=globalThis.setTimeout, originalClearTimeout=globalThis.clearTimeout;
 const timers=[]; let calls=0;
 globalThis.setTimeout=fn=>{timers.push(fn);return fn;};
 globalThis.clearTimeout=()=>{};
 try {
  startProactive({ownerId:'123',activeStart:0,activeEnd:0,initialDelayMs:0,memory,
   brain:{reply:async()=>{calls++;return {text:'{}'};}},bot:{send:async()=>({ok:true})}});
  await timers.shift()();
  assert.equal(calls,0);
 } finally { stopProactive(); globalThis.setTimeout=originalSetTimeout; globalThis.clearTimeout=originalClearTimeout; }
});
