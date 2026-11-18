import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createMemoryBrain} from '../src/memory-brain-adapter.js';

test('explicit engine root is honored and missing deployment fails closed', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-deploy-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const mb=createMemoryBrain({enabled:true,directory:path.join(dir,'db'),engineRoot:path.join(dir,'missing'),authorize:()=>true,recoveryAuthorization:()=>true});
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
 await assert.rejects(mb.remember(scope,{text:'苹果',source:'chat',evidence:'1'}));
});

test('relocated real engine persists and recalls without the default path', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'mb-relocate-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const engineRoot=path.join(dir,'engine');
 fs.mkdirSync(engineRoot);
 fs.cpSync('/root/memory-brain/memory_core',path.join(engineRoot,'memory_core'),{recursive:true,filter:p=>!p.includes('__pycache__')});
 const mb=createMemoryBrain({enabled:true,directory:path.join(dir,'db'),engineRoot,authorize:()=>true,recoveryAuthorization:()=>true});
 const scope={tenant:'t',platform:'qq',type:'private',session:'private:1',user:'1'};
 await mb.remember(scope,{text:'苹果秘密',source:'chat',evidence:'relocated-1'});
 assert.equal((await mb.recall(scope,{query:'苹果',sources:['chat']}))[0].evidence,'relocated-1');
});
