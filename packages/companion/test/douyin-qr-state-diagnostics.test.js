import test from 'node:test';
import assert from 'node:assert/strict';
import { decideQrAction, safeQrDiagnostic } from '../src/douyin-qr-state.js';
import {createLoginService} from '../src/room-login-service.js';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('confirmation never refreshes or reopens while awaiting candidate',()=>{
 assert.equal(decideQrAction({confirmation:true, isQrScreen:true, refreshDue:true}), 'confirm');
 assert.equal(decideQrAction({confirmation:true, isQrScreen:false, reopenDue:true}), 'confirm');
});
test('challenge precedes candidate; candidate precedes refresh',()=>{
 assert.equal(decideQrAction({risk:true, hasSession:true, modalGone:true}), 'challenge');
 assert.equal(decideQrAction({hasSession:true, modalGone:true, isExpired:true}), 'candidate');
 assert.equal(decideQrAction({isExpired:true}), 'refresh');
 assert.equal(decideQrAction({challengePending:true, isExpired:true}), 'hold');
});
test('service exposes confirmation but never online without verification',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qr-service-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let dir, child;const service=createLoginService({dataDir:root,headedSessionRoot:path.join(root,'headed'),spawnLogin:(_a,_b,o)=>{dir=o.env.DOUYIN_LOGIN_SESSION_DIR;child=new EventEmitter();child.exitCode=null;child.kill=()=>{};return child;},verifyDouyin:async()=>({state:'unknown'})});
 service.startDouyin();fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'confirm'}));
 assert.deepEqual(await service.douyinProgress(),{state:'confirm'});
 fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
 assert.deepEqual(await service.douyinProgress(),{state:'unknown'});
 const events=service.douyinDiagnostics();assert.ok(['confirm','candidate','verifying','verify_unknown'].every(x=>events.some(e=>e.stage===x)));
 assert.ok(!JSON.stringify(events).includes('synthetic'));
 assert.equal(fs.existsSync(path.join(root,'douyin-cookies.json')),false);
});
test('diagnostics only serialize allowlisted stage names',()=>{
 assert.equal(safeQrDiagnostic('confirm'), 'confirm');
 assert.equal(safeQrDiagnostic('token=secret'), 'unknown');
 assert.equal(safeQrDiagnostic({secret:'private'}), 'unknown');
});
