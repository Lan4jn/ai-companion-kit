import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLoginService } from '../src/room-login-service.js';

test('抖音遇验证时保留原扫码会话，隐藏二维码，完成后验证候选凭据', async t => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'login-handoff-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let session, killed=false;
  const svc=createLoginService({dataDir:dir,spawnLogin:(_c,_a,opts)=>{session=opts.env.DOUYIN_LOGIN_SESSION_DIR;const c=new EventEmitter();c.exitCode=null;c.kill=()=>{killed=true;};return c;},verifyDouyin:async()=>({state:'online'})});
  fs.writeFileSync(path.join(dir,'douyin-cookies.json'),'old');
  svc.startDouyin();
  fs.writeFileSync(path.join(session,'qr.png'),'fake');
  fs.writeFileSync(path.join(session,'status.json'),JSON.stringify({status:'need_sms'}));
  assert.equal((await svc.douyinProgress()).state,'challenge');
  assert.equal(svc.douyinPng(),null);
  assert.equal(killed,false);
  assert.equal(fs.existsSync(session),true);
  assert.equal(fs.readFileSync(path.join(dir,'douyin-cookies.json'),'utf8'),'old');
  fs.writeFileSync(path.join(session,'cookies.json'),JSON.stringify([{name:'sessionid',value:'candidate'}]));
  fs.writeFileSync(path.join(session,'status.json'),JSON.stringify({status:'success'}));
  assert.equal((await svc.douyinProgress()).state,'online');
  assert.equal(fs.existsSync(session),false);
});
