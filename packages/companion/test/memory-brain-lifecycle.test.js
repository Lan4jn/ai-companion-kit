import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMemoryBrain } from '../src/memory-brain-adapter.js';

test('authorized deletion removes only the requested evidence and scope', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'mb-life-'));
 try {
  const seen = [];
  const brain = createMemoryBrain({enabled:true, directory:dir, authorize:async (c,op,source) => { seen.push([op,source]); return c.ok === true; }, recoveryAuthorization: async ()=>true });
  const a = {ok:true, tenant:'t',platform:'p',type:'private',session:'a',user:'a'};
  const b = {...a,session:'b',user:'b'};
  await brain.remember(a,{text:'apple first',source:'chat',evidence:'one'});
  await brain.remember(a,{text:'apple second',source:'chat',evidence:'two'});
  await brain.remember(b,{text:'apple other',source:'chat',evidence:'one'});
  await assert.rejects(brain.forget({...a,ok:false},{source:'chat',evidence:'one'}));
  assert.equal(await brain.forget(a,{source:'chat',evidence:'one'}),1);
  assert.equal(await brain.forget(a,{source:'chat',evidence:'one'}),0);
  assert.deepEqual((await brain.recall(a,{query:'apple',sources:['chat']})).map(x=>x.evidence),['two']);
  assert.equal((await brain.recall(b,{query:'apple',sources:['chat']}))[0].evidence,'one');
  assert.ok(seen.some(([op,source])=>op==='forget' && source==='chat'));
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
