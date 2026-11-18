import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCredentialStore} from '../src/douyin-credential-store.js';
import {beginDouyinRenewal,createBrowserRenewal} from '../src/douyin-credential-renewal.js';
import {spawnSync} from 'node:child_process';

test('renewal persists changed same-account cookies with CAS and private mode', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-renew-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=createCredentialStore(dir), old=[{name:'sessionid',value:'synthetic-old',domain:'.douyin.com',path:'/',expires:-1}];
 store.commit(store.snapshot().version,old);
 const renewal=beginDouyinRenewal({store,enabled:true,verify:async()=>({state:'online',identity:'synthetic-id'})});
 const updated=[{...old[0],value:'synthetic-new'}];
 assert.equal(await renewal.finish(updated),true);
 assert.deepEqual(store.snapshot().cookies,updated);
 assert.equal(fs.statSync(path.join(dir,'douyin-cookies.json')).mode & 0o777,0o600);
});


test('unknown, mismatched, error and disabled verifiers never persist', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-renew-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=createCredentialStore(dir), old=[{name:'sessionid',value:'old',domain:'.douyin.com',path:'/',expires:-1}], candidate=[{name:'sessionid',value:'new',domain:'.douyin.com',path:'/',expires:-1}];
 store.commit(store.snapshot().version,old);
 for (const [enabled,verify] of [
  [false,async()=>({state:'online',identity:'same'})],
  [true,async()=>({state:'unknown'})],
  [true,async()=>{throw Error('network secret')}],
  [true,async c=>({state:'online',identity:c[0].value})],
  [true,async()=>({state:'online'})],
 ]) {
  const renewal=beginDouyinRenewal({store,enabled,verify});
  assert.equal(await renewal.finish(candidate),false);
  assert.deepEqual(store.snapshot().cookies,old);
 }
});

test('logout and new login in another process cannot be undone by in-flight renewal', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-renew-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=createCredentialStore(dir), old=[{name:'sessionid',value:'old',domain:'.douyin.com',path:'/',expires:-1}], candidate=[{name:'sessionid',value:'new',domain:'.douyin.com',path:'/',expires:-1}];
 const url=new URL('../src/douyin-credential-store.js',import.meta.url).href;
 for(const action of ['remove','commit']) {
  store.commit(store.snapshot().version,old);
  let called=0;
  const renewal=beginDouyinRenewal({store,enabled:true,verify:async()=>{
   if (++called===2) {
    const code=`import {createCredentialStore} from ${JSON.stringify(url)};const s=createCredentialStore(process.argv[1]);const v=s.snapshot().version;${action==='remove'?'s.remove(v)':'s.commit(v,[{name:"sessionid",value:"other"}])'}`;
    const child=spawnSync(process.execPath,['--experimental-default-type=module','--input-type=module','-e',code,dir],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
   }
   return {state:'online',identity:'same'};
  }});
  assert.equal(await renewal.finish(candidate),false);
  assert.deepEqual(store.snapshot().cookies,action==='remove'?null:[{name:'sessionid',value:'other'}]);
 }
});

test('browser verifier uses distinct contexts and rejects HTTP errors and absent secure identity', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-renew-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=createCredentialStore(dir), old=[{name:'sessionid',value:'old',domain:'.douyin.com',path:'/',expires:-1}], candidate=[{name:'sessionid',value:'new',domain:'.douyin.com',path:'/',expires:-1}];
 store.commit(store.snapshot().version,old); let contexts=0,closed=0; let status=200, body={status_code:0,user:{sec_uid:'same'}};
 const browser={newContext:async()=>{contexts++;return {addCookies:async()=>{},request:{get:async(_url,opts)=>{assert.equal(opts.maxRedirects,0);return {ok:()=>status===200,json:async()=>body}}},close:async()=>{closed++}}}};
 assert.equal(await createBrowserRenewal(dir,browser,true).finish(candidate),true);
 assert.equal(contexts,2);assert.equal(closed,2);
 status=403; assert.equal(await createBrowserRenewal(dir,browser,true).finish(old),false);
 status=200;body={status_code:0,user:{uid:'unsafe-fallback'}};assert.equal(await createBrowserRenewal(dir,browser,true).finish(old),false);
 assert.deepEqual(store.snapshot().cookies,candidate);assert.equal(contexts,closed);
});
