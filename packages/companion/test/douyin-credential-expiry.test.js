import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createLoginService} from '../src/room-login-service.js';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('stalled candidate verification expires and cannot later promote credentials', async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-verify-deadline-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  let release;
  const svc=createLoginService({dataDir,headedDouyin:true,headedVerifyMs:80,headedDaemonPath:path.resolve('test/fixtures/douyin-headed-fake.js'),verifyDouyin:()=>new Promise(r=>release=r)});
  svc.startHeadedDouyin();
  let display;
  for(let i=0;i<100&&!display;i++){display=svc.headedDouyinDisplay();if(!display)await pause(10);}
  assert.ok(display);
  const dir=path.dirname(display.socket);
  fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'fake-session'}]));
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
  const outcome=await Promise.race([svc.headedDouyinProgress(),pause(1500).then(()=>({state:'hung'}))]);
  assert.deepEqual(outcome,{state:'expired'});
  assert.equal(fs.existsSync(dir),false);
  release({state:'online'}); await pause(30);
  assert.equal(fs.existsSync(path.join(dataDir,'douyin-cookies.json')),false);
  await svc.cancelHeadedDouyin();
});
