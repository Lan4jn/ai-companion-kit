import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCredentialStore} from '../src/douyin-credential-store.js';
import {beginDouyinRenewal} from '../src/douyin-credential-renewal.js';

test('renewal rejects unrelated-domain or expired session cookies even if identity verifier reports online',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const s=createCredentialStore(dir),old=[{name:'sessionid',value:'old',domain:'.douyin.com',path:'/',expires:-1}];s.commit(s.snapshot().version,old);
 for(const bad of [
  {name:'sessionid',value:'new',domain:'douyin.com',path:'/',expires:-1},
  {name:'sessionid',value:'new',domain:'evil-douyin.com',path:'/',expires:-1},
  {name:'sessionid',value:'new',domain:'login.douyin.com',path:'/',expires:-1},
  {name:'sessionid',value:'new',domain:'.douyin.com',path:'/',expires:1},
  {name:'sessionid',value:'new',domain:'.douyin.com',path:'/other',expires:-1},
 ]) {
  const renewal=beginDouyinRenewal({store:s,enabled:true,verify:async()=>({state:'online',identity:'fake'})});
  assert.equal(await renewal.finish([bad]),false);
  assert.deepEqual(s.snapshot().cookies,old);
 }
});
