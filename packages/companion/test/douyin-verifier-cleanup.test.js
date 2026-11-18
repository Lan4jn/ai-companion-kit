import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createLoginService} from '../src/room-login-service.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fake=path.resolve('test/fixtures/douyin-headed-fake.js');
test('verification timeout aborts a real independent verifier process',async t=>{
  const root=fs.mkdtempSync(path.join(process.env.TMPDIR,'verify-test-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let verifier;
  const svc=createLoginService({headedDouyin:true,headedDaemonPath:fake,headedVerifyMs:150,dataDir:root,
    browserLauncher:{launch:()=>new Promise(()=>{})},
    forkVerifier:(file,args,opts)=>{verifier=fork(path.resolve('test/fixtures/douyin-verifier-hang.js'),args,opts);return verifier;}});
  svc.startHeadedDouyin(); let d;
  for(let i=0;i<100 && !d;i++){await pause(20);d=svc.headedDouyinDisplay();}
  assert.ok(d); const dir=path.dirname(d.socket);
  fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
  assert.deepEqual(await svc.headedDouyinProgress(),{state:'expired'});
  assert.ok(verifier, 'verification must run in a child');
  assert.notEqual(verifier.signalCode,null);
  assert.equal(fs.existsSync(dir),false);
});
