import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initializeMemoryBrainSession} from '../src/memory-brain-session-candidate.js';

test('fresh trusted session allows scoped remember and recall, then denies on uncertainty', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mb-session-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let trusted=true;
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
 const session=initializeMemoryBrainSession({directory:path.join(root,'store'),scope,sources:['chat'],continuity:()=>trusted});
 await session.memory.remember(scope,{text:'apple likes tea',source:'chat',evidence:'one'});
 assert.equal((await session.memory.recall(scope,{query:'apple',sources:['chat']})).length,1);
 await assert.rejects(session.memory.recall({...scope,user:'2'},{query:'apple',sources:['chat']}));
 await assert.rejects(session.memory.recall(scope,{query:'apple',sources:['other']}));
 trusted=false;
 await assert.rejects(session.memory.recall(scope,{query:'apple',sources:['chat']}));
 await assert.rejects(session.memory.remember(scope,{text:'x',source:'chat',evidence:'two'}));
 trusted=true;
 await assert.rejects(session.memory.recall(scope,{query:'apple',sources:['chat']}));
});

test('existing or replaced directory cannot be implicitly trusted', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mb-session-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directory=path.join(root,'store');
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
 const opts={directory,scope,sources:['chat'],continuity:()=>true};
 const session=initializeMemoryBrainSession(opts);
 assert.throws(()=>initializeMemoryBrainSession(opts),/EEXIST/);
 fs.renameSync(directory,path.join(root,'old')); fs.mkdirSync(directory,{mode:0o700});
 await assert.rejects(session.memory.recall(scope,{query:'apple',sources:['chat']}));
 fs.rmSync(directory,{recursive:true}); fs.renameSync(path.join(root,'old'),directory);
 await assert.rejects(session.memory.recall(scope,{query:'apple',sources:['chat']}));
});
