import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createLoginService} from '../src/room-login-service.js';

test('refreshing never serves the previous QR and challenged start resumes same session', async t => {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'qr-refresh-test-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let dir, count=0; const svc=createLoginService({dataDir:root,spawnLogin:(_c,_a,o)=>{count++;dir=o.env.DOUYIN_LOGIN_SESSION_DIR;const child=new EventEmitter(); child.exitCode=null;child.kill=()=>{};return child;}});
 svc.startDouyin(); fs.writeFileSync(path.join(dir,'qr.png'),'synthetic');
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'ready'}));
 assert.equal(svc.douyinPng().toString(),'synthetic');
 const stale=new Date(Date.now()-61000); fs.utimesSync(path.join(dir,'qr.png'),stale,stale);
 assert.equal(svc.douyinPng(),null,'old ready image must not survive its TTL');
 fs.writeFileSync(path.join(dir,'qr.png'),'replacement');
 assert.equal(svc.douyinPng().toString(),'replacement');
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'refreshing'}));
 assert.equal(svc.douyinPng(),null);
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'need_sms'}));
 assert.equal((await svc.douyinProgress()).state,'challenge');
 assert.equal(svc.startDouyin().state,'challenge'); assert.equal(count,1);
});
