import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('adapter requires explicit boolean opt-in, not truthy configuration', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'mb-optin-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for (const enabled of ['true', 1, {}, ['true']]) {
  const store=path.join(dir, String(typeof enabled));
  const mb=createMemoryBrain({enabled,directory:store,authorize:()=>true,recoveryAuthorization:()=>true});
  const scope={tenant:'t',platform:'qq',type:'private',session:'s',user:'u'};
  assert.equal(await mb.remember(scope,{text:'hello',source:'test',evidence:'1'}),null);
  assert.deepEqual(await mb.recall(scope,{query:'hello',sources:['test']}),[]);
  assert.deepEqual(await mb.rankCandidates(scope,{query:'hello',candidates:[{text:'hello',source:'test',evidence:'1'}]}),[]);
  assert.equal(fs.existsSync(store),false);
 }
});
