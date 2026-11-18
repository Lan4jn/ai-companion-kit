import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentialStore } from '../src/douyin-credential-store.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createLoginService } from '../src/room-login-service.js';

test('stale candidate cannot resurrect after logout or replace newer credentials', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-store-test-'));
  try {
    const store=createCredentialStore(dir), empty=store.snapshot();
    assert.equal(store.commit(empty.version,[{name:'sessionid',value:'mock-one'}]),true);
    const old=store.snapshot();
    assert.equal(store.remove(old.version),true);
    assert.equal(store.commit(old.version,[{name:'sessionid',value:'mock-old'}]),false);
    const tombstone=store.snapshot();
    assert.equal(store.commit(tombstone.version,[{name:'sessionid',value:'mock-two'}]),true);
    assert.equal(store.commit(old.version,[{name:'sessionid',value:'mock-old'}]),false);
    assert.equal(fs.statSync(path.join(dir,'douyin-cookies.json')).mode & 0o777,0o600);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('independent processes with same snapshot allow at most one commit', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-store-process-'));
  try {
    const store=createCredentialStore(dir), version=store.snapshot().version;
    const moduleUrl=new URL('../src/douyin-credential-store.js',import.meta.url).href;
    const code=`import {createCredentialStore} from ${JSON.stringify(moduleUrl)}; const s=createCredentialStore(process.argv[1]); try {console.log(s.commit(process.argv[2],[{name:'sessionid',value:process.argv[3]}])?'won':'lost')} catch(e) {if(e.code==='EEXIST') console.log('busy'); else throw e}`;
    const run=i=>new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,['--input-type=module','-e',code,dir,version,String(i)]);let output='',err='';
      child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>err+=b);
      child.on('error',reject);child.on('exit',c=>c===0?resolve(output.trim()):reject(new Error(err)));
    });
    const results=await Promise.all(Array.from({length:12},(_,i)=>run(i)));
    assert.equal(results.filter(x=>x==='won').length,1);
    assert.equal(results.every(x=>['won','lost','busy'].includes(x)),true);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('logout during candidate verification rejects the old login', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-store-login-'));
  let session, release, started;
  const waiting=new Promise(r=>started=r);
  try {
    const store=createCredentialStore(dir);store.commit(store.snapshot().version,[{name:'sessionid',value:'mock-old'}]);
    const svc=createLoginService({dataDir:dir,spawnLogin:(_c,_a,opts)=>{session=opts.env.DOUYIN_LOGIN_SESSION_DIR;const p=new EventEmitter();p.exitCode=null;p.kill=()=>{};return p;},verifyDouyin:()=>{started();return new Promise(r=>release=r);}});
    assert.equal(svc.startDouyin().state,'waiting');
    fs.writeFileSync(path.join(session,'cookies.json'),JSON.stringify([{name:'sessionid',value:'mock-candidate'}]));
    fs.writeFileSync(path.join(session,'status.json'),JSON.stringify({status:'success'}));
    const pending=svc.douyinProgress();await waiting;
    assert.equal(store.remove(store.snapshot().version),true);
    release({state:'online'});
    assert.equal((await pending).state,'unknown');
    assert.equal(store.snapshot().cookies,null);
  } finally {if(session)fs.rmSync(session,{recursive:true,force:true});fs.rmSync(dir,{recursive:true,force:true});}
});
