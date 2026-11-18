import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createLoginService} from '../src/room-login-service.js';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('TTL after candidate publication waits for verification and preserves successful candidate', async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'headed-ttl-race-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  let release, started;
  const verifying=new Promise(r=>started=r);
  const svc=createLoginService({headedDouyin:true,headedTtlMs:500,headedDaemonPath:path.resolve('test/fixtures/douyin-headed-fake.js'),dataDir,
    verifyDouyin:()=>{started();return new Promise(r=>release=r);}});
  assert.equal(svc.startHeadedDouyin().state,'starting');
  let display;
  for(let i=0;i<100&&!display;i++){display=svc.headedDouyinDisplay();if(!display)await pause(10);}
  assert.ok(display);
  const dir=path.dirname(display.socket);
  fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
  const progress=svc.headedDouyinProgress(); await verifying;
  await pause(650);
  release({state:'online'});
  assert.deepEqual(await progress,{state:'online'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir,'douyin-cookies.json'),'utf8'))[0].value,'synthetic');
});

test('TTL discovers and verifies a candidate without a progress poll', async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'headed-ttl-published-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const svc=createLoginService({headedDouyin:true,headedTtlMs:500,headedDaemonPath:path.resolve('test/fixtures/douyin-headed-fake.js'),dataDir,verifyDouyin:async()=>({state:'online'})});
  svc.startHeadedDouyin();
  let display;
  for(let i=0;i<100&&!display;i++){display=svc.headedDouyinDisplay();if(!display)await pause(10);}
  assert.ok(display);
  const dir=path.dirname(display.socket);
  fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
  await pause(800);
  assert.deepEqual(await svc.headedDouyinProgress(),{state:'online'});
  assert.equal(fs.existsSync(dir),false);
});
