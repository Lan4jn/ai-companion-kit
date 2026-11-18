import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {initializeManagedStore} from '../src/memory-brain-trust.js';
import Database from 'better-sqlite3';
const childPath=new URL('./fixtures/bili-dm-crash-child.js',import.meta.url);
test('SIGKILL after dispatch and new process never resend unknown',async()=>{
 const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-kill-'));const dir=path.join(home,'managed');initializeManagedStore(dir);
 const launch=()=>fork(childPath,[],{env:{...process.env,HOME:home,FIXTURE_STORE:dir},stdio:['ignore','inherit','inherit','ipc']});
 try {
  const first=launch(); const msg=await new Promise((resolve,reject)=>{first.once('message',resolve); first.once('error',reject);}); assert.equal(msg,'send');
  const dead=new Promise(resolve=>first.once('exit',(code,signal)=>resolve({code,signal})));first.kill('SIGKILL');assert.equal((await dead).signal,'SIGKILL');
  const db=new Database(path.join(home,'.bili-ai/dm-ledger/ledger.sqlite3'),{readonly:true}); assert.equal(db.prepare('SELECT status FROM attempts').get().status,'unknown'); db.close();
  const second=launch(); const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{second.kill('SIGKILL');reject(Error('child timeout'));},15000);second.once('message',m=>{clearTimeout(timer);resolve(m);});second.once('error',reject);}); assert.equal(result,'done');
  await new Promise(resolve=>second.once('exit',resolve));
 } finally {fs.rmSync(home,{recursive:true,force:true});}
});
