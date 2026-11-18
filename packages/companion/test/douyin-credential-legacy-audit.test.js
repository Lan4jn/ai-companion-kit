import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createCredentialStore} from '../src/douyin-credential-store.js';

test('uncooperative legacy writer after CAS can overwrite committed credentials',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-legacy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=createCredentialStore(dir);const target=path.join(dir,'douyin-cookies.json');
 const first=[{name:'sessionid',value:'fake-first'}],next=[{name:'sessionid',value:'fake-next'}],legacy=[{name:'sessionid',value:'fake-legacy'}];
 assert.equal(store.commit(store.snapshot().version,first),true);
 assert.equal(store.commit(store.snapshot().version,next),true);
 const c=spawnSync(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],process.argv[2])",target,JSON.stringify(legacy)],{encoding:'utf8'});
 assert.equal(c.status,0,c.stderr);assert.deepEqual(store.snapshot().cookies,legacy);
});
