import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createPhoneMutex} from '../src/phone-mutex.js';
import {observeFanqieCandidates} from '../src/fanqie-device-navigation.js';

test('lock holder death terminates in-flight adb instead of leaving it running', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-lock-death-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'adb'),`#!/bin/sh\necho $$ > '${dir}/adb.pid'\nexec sleep 30\n`,{mode:0o755});
 const oldPath=process.env.PATH,oldSerial=process.env.PHONE_SERIAL;
 process.env.PATH=dir+path.delimiter+oldPath;process.env.PHONE_SERIAL='fake';
 t.after(()=>{process.env.PATH=oldPath;if(oldSerial===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=oldSerial});
 const lockPath=path.join(dir,'phone.lock');
 const pending=createPhoneMutex({lockPath}).tryBackground(()=>observeFanqieCandidates({serial:'fake'}));
 pending.catch(()=>{});
 let pid;for(let i=0;i<200;i++){try{pid=Number(await fs.readFile(path.join(dir,'adb.pid'),'utf8'));break}catch{await new Promise(r=>setTimeout(r,10));}}
 assert.ok(pid);
 const holder=Number((await fs.readFile(lockPath+'.unclean','utf8')).match(/pid=(\d+)/)[1]);
 process.kill(holder,'SIGKILL');
 try {
  await Promise.race([pending.catch(()=>{}),new Promise((_,reject)=>setTimeout(()=>reject(Error('adb survived lock loss')),1200))]);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 } finally {try{process.kill(-pid,'SIGKILL')}catch{} await pending.catch(()=>{});}
});
