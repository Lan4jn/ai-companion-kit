import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBrain } from '../src/memory-brain-adapter.js';

test('authorized scope is filtered before ranking and evidence stays scoped', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'mb-test-'));
 try {
  const auth = async c => c.authenticated === true;
  const brain = createMemoryBrain({ enabled: true, directory: dir, authorize: auth,recoveryAuthorization:(c,op,source)=>c.tenant==='t' && ['a','b'].includes(c.user) && ['qq','other'].includes(c.platform) && op==='recall' && source==='chat' });
  const a = {authenticated:true, tenant:'t', platform:'qq', type:'private', session:'a', user:'a'};
  const b = {...a, session:'b', user:'b'};
  await brain.remember(a,{text:'共同的苹果秘密',source:'chat',evidence:'event-a'});
  await brain.remember(b,{text:'共同的苹果秘密其他',source:'chat',evidence:'event-b'});
  const rows = await brain.recall(a,{query:'苹果',sources:['chat']});
  assert.equal(rows.length,1); assert.equal(rows[0].evidence,'event-a');
  const files = readdirSync(dir).filter(x => x.endsWith('.sqlite3'));
  assert.equal(files.length,2);
  for (const file of files) assert.equal(statSync(join(dir,file)).mode & 0o777,0o600);
  assert.deepEqual(await brain.recall({...a,platform:'other'},{query:'苹果',sources:['chat']}),[]);
  await assert.rejects(brain.recall({...a,authenticated:false},{query:'苹果',sources:['chat']}));
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
