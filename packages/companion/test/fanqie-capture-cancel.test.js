import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createPhoneMutex} from '../src/phone-mutex.js';
import {startFanqieAutonomous} from '../src/fanqie-startup.js';
import {observeFanqieCandidates} from '../src/fanqie-device-navigation.js';
import {createFanqieWant} from '../src/fanqie-want.js';

test('stop terminates blocked adb process and releases cross-process mutex',{timeout:15000},async t=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-cancel-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'adb'),`#!/bin/sh\necho $$ > '${dir}/pid'\ntrap '' TERM\nwhile :; do sleep 1; done\n`,{mode:0o755});
 const oldPath=process.env.PATH,oldSerial=process.env.PHONE_SERIAL;process.env.PATH=dir+path.delimiter+oldPath;process.env.PHONE_SERIAL='fake';
 t.after(()=>{process.env.PATH=oldPath;if(oldSerial===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=oldSerial});
 const lockPath=path.join(dir,'lock'),mutex=createPhoneMutex({lockPath});let want;
 const handle=startFanqieAutonomous({enabled:true,serial:'fake',dataDir:dir,brain:{complete:async()=>'{"want":true}'},mutex,createIntegration(o){want=o.want;return {scheduler:{start(){},stop(){}}}}});
 t.after(()=>handle.stop());
 const pending=want();const rejected=assert.rejects(pending,/decision unavailable/);
 let pid;const deadline=performance.now()+10000;
 while(performance.now()<deadline){try{pid=Number(await fs.readFile(path.join(dir,'pid'),'utf8'));if(pid>0)break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,10));}
 assert.ok(pid>0,'fake adb must start before stop');assert.doesNotThrow(()=>process.kill(pid,0));
 const other=createPhoneMutex({lockPath});
 assert.equal(await other.tryBackground(async()=>{}),false,'lock must be held while adb is running');
 handle.stop();await rejected;
 let acquired=false;
 for(let i=0;i<500&&!acquired;i++){acquired=await other.tryBackground(async()=>{assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});});if(!acquired)await new Promise(r=>setTimeout(r,10));}
 assert.equal(acquired,true);
});


test('decision timeout cancels process before releasing lock',{timeout:15000},async t=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fq-timeout-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'adb'),`#!/bin/sh\necho $$ > '${dir}/pid'\ntrap '' TERM\nwhile :; do sleep 1; done\n`,{mode:0o755});
 const oldPath=process.env.PATH,oldSerial=process.env.PHONE_SERIAL;process.env.PATH=dir+path.delimiter+oldPath;process.env.PHONE_SERIAL='fake';
 t.after(()=>{process.env.PATH=oldPath;if(oldSerial===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=oldSerial});
 const lockPath=path.join(dir,'lock'), mutex=createPhoneMutex({lockPath});
 t.mock.timers.enable({apis:['setTimeout']});
 let operation;const want=createFanqieWant({timeoutMs:400,brain:{complete:async()=>'{"want":true}'},context:({signal})=>{operation=mutex.tryBackground(()=>observeFanqieCandidates({serial:'fake',signal}));return operation;}});
 const decision=want(); const rejected=assert.rejects(decision,/decision unavailable/);
 let pid;const deadline=performance.now()+10000;
 while(performance.now()<deadline){try{pid=Number(await fs.readFile(path.join(dir,'pid'),'utf8'));if(pid>0)break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(setImmediate);}
 assert.ok(pid>0,'fake adb must start before the timeout');
 assert.doesNotThrow(()=>process.kill(pid,0));
 assert.equal(await createPhoneMutex({lockPath}).tryBackground(async()=>{}),false,'lock must be held while adb is running');
 t.mock.timers.tick(400);
 await rejected;await assert.rejects(operation,/capture unavailable/);
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 assert.equal(await createPhoneMutex({lockPath}).tryBackground(async()=>{assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});}),true);
});
