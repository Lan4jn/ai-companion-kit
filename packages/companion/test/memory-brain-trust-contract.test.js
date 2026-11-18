import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createManagedMemoryBrain, initializeManagedStore, restoreManagedStore, reviewManagedStore} from '../src/memory-brain-trust.js';

test('trusted scoped memory persists across restart and controlled restore requires review', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'memory-trust-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const live=path.join(root,'live'), backup=path.join(root,'backup'), restored=path.join(root,'restored');
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
 initializeManagedStore(live);
 const options={directory:live,scope,sources:['chat'],trustedProcess:true};
 const brain=createManagedMemoryBrain(options);
 await brain.remember(scope,{text:'synthetic apple',source:'chat',evidence:'one'});
 assert.equal((await createManagedMemoryBrain(options).recall(scope,{query:'apple',sources:['chat']})).length,1);
 await assert.rejects(brain.recall({...scope,user:'2'},{query:'apple',sources:['chat']}));
 await assert.rejects(brain.recall(scope,{query:'apple',sources:['other']}));
 fs.cpSync(live,backup,{recursive:true});
 restoreManagedStore(backup,restored);
 const restoredBrain=createManagedMemoryBrain({...options,directory:restored});
 await assert.rejects(restoredBrain.recall(scope,{query:'apple',sources:['chat']}),/review/);
 await assert.rejects(restoredBrain.rankCandidates(scope,{query:'apple',candidates:[{text:'apple',source:'chat',evidence:'one'}]}),/review/);
 assert.throws(()=>reviewManagedStore(restored,'wrong'),/confirmation/);
 reviewManagedStore(restored,'I REVIEWED ALL REVOCATIONS AND FORGETS');
 assert.equal((await restoredBrain.recall(scope,{query:'apple',sources:['chat']})).length,1);
});
