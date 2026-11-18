import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, cpSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('restored directory is closed without a fresh in-process grant', async t => {
 const root=mkdtempSync(join(tmpdir(),'memory-recovery-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dir=join(root,'live'), backup=join(root,'backup'); mkdirSync(dir,{mode:0o700});
 const context={tenant:'t',platform:'p',type:'private',session:'s',user:'u'};
 const opts={enabled:true,directory:dir,authorize:()=>true,recoveryAuthorization:()=>true};
 const b=createMemoryBrain(opts);
 await b.remember(context,{text:'synthetic apple',source:'chat',evidence:'1'});
 cpSync(dir,backup,{recursive:true}); await b.revoke(context,{source:'chat'});
 rmSync(dir,{recursive:true}); cpSync(backup,dir,{recursive:true});
 const restored=createMemoryBrain({...opts,recoveryAuthorization:undefined});
 await assert.rejects(restored.recall(context,{query:'apple',sources:['chat']}),/recovery authorization/);
 await assert.rejects(restored.rankCandidates(context,{query:'apple',candidates:[{text:'apple',source:'chat',evidence:'1'}]}),/recovery authorization/);
 const reviewed=createMemoryBrain(opts);
 assert.ok((await reviewed.recall(context,{query:'apple',sources:['chat']})).length > 0);
});
