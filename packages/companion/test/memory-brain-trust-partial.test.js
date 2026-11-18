import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initializeManagedStore,restoreManagedStore,reviewManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
test('failed restore cannot be reviewed or used', async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mb-partial-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const backup=path.join(root,'backup'),dest=path.join(root,'dest'); initializeManagedStore(backup);
 fs.writeFileSync(path.join(backup,'unexpected'), 'synthetic',{mode:0o600});
 assert.throws(()=>restoreManagedStore(backup,dest),/unsafe backup/);
 assert.throws(()=>reviewManagedStore(dest,'I REVIEWED ALL REVOCATIONS AND FORGETS'),/not awaiting review/);
 const scope={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
 const brain=createManagedMemoryBrain({directory:dest,scope,sources:['chat'],trustedProcess:true});
 await assert.rejects(brain.recall(scope,{query:'x',sources:['chat']}));
});
