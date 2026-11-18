import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLoginService} from '../src/room-login-service.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('published candidate and concurrent disconnect share one verification', {timeout:10000}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'candidate-race-'));let release,notify,calls=0;
 const svc=createLoginService({headedDouyin:true,dataDir:root,headedDaemonPath:path.resolve('test/fixtures/douyin-headed-fake.js'),verifyDouyin:()=>{calls++;notify();return new Promise(r=>release=r)}});
 try {assert.equal(svc.startHeadedDouyin().state,'starting');let d;for(let i=0;i<100&&!d;i++){d=svc.headedDouyinDisplay();if(!d)await pause(20)}assert.ok(d);
 const dir=path.dirname(d.socket);fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
 const started=new Promise(r=>notify=r);const progress=svc.headedDouyinProgress();await started;const disconnected=svc.disconnectHeadedDouyin();release({state:'online'});assert.deepEqual(await progress,{state:'online'});assert.deepEqual(await disconnected,{state:'online'});assert.equal(calls,1);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'douyin-cookies.json')))[0].value,'synthetic');assert.equal(fs.existsSync(dir),false);
 } finally {release?.({state:'offline'});await svc.cancelHeadedDouyin();fs.rmSync(root,{recursive:true,force:true})}
});
