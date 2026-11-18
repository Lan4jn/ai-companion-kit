import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createLoginService } from '../src/room-login-service.js';

test('headed local API is disabled by default', () => {
  const svc=createLoginService();
  assert.deepEqual(svc.startHeadedDouyin(), {state:'disabled'});
});
const fake=path.resolve('test/fixtures/douyin-headed-fake.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitDisplay(svc) {
  for (let i=0;i<100;i++) {const d=svc.headedDouyinDisplay(); if(d) return d; await pause(20);}
  throw Error('fake daemon not ready');
}
test('cancellation waits for daemon exit and retains lock until cleanup', async () => {
  const svc=createLoginService({headedDouyin:true,headedDaemonPath:fake});
  assert.equal(svc.startHeadedDouyin().state,'starting');
  const display=await waitDisplay(svc);
  const dir=path.dirname(display.socket);
  assert.equal(svc.startHeadedDouyin().state,'busy');
  assert.equal(svc.startDouyin().state,'busy');
  const cancel=svc.cancelHeadedDouyin();
  assert.equal(svc.headedDouyinDisplay(),null);
  assert.equal(svc.startHeadedDouyin().state,'busy');
  assert.equal(fs.existsSync(dir),true);
  assert.deepEqual(await cancel,{state:'expired'});
  assert.equal(fs.existsSync(dir),false);
  await pause(200);
  assert.equal(fs.existsSync(dir),false);
});
test('timeout waits for exit then cleans temporary files', async () => {
  const svc=createLoginService({headedDouyin:true,headedDaemonPath:fake,headedTtlMs:500});
  svc.startHeadedDouyin();
  const dir=path.dirname((await waitDisplay(svc)).socket);
  await pause(800);
  assert.deepEqual(await svc.headedDouyinProgress(),{state:'expired'});
  assert.equal(fs.existsSync(dir),false);
});
test('cancel during independent verification never promotes the candidate', async t => {
  const dataDir=fs.mkdtempSync(path.join(process.env.TMPDIR,'headed-data-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dataDir,'douyin-cookies.json'),'original');
  let unblock, started;
  const verifying=new Promise(r=>started=r);
  const svc=createLoginService({headedDouyin:true,headedDaemonPath:fake,dataDir,
    forkHeaded:(file,args,opts)=>fork(file,args,{...opts,env:{...opts.env,FAKE_SUCCESS:'1'}}),
    verifyDouyin:()=>{started(); return new Promise(r=>unblock=r);}});
  svc.startHeadedDouyin();
  await waitDisplay(svc);
  await pause(250);
  const pending=svc.headedDouyinProgress();
  await verifying;
  assert.deepEqual(await svc.cancelHeadedDouyin(),{state:'expired'});
  unblock({state:'online'});
  assert.deepEqual(await pending,{state:'expired'});
  assert.equal(fs.readFileSync(path.join(dataDir,'douyin-cookies.json'),'utf8'),'original');
});

// A successful daemon status wins over a subsequent viewer disconnect, even
// while the daemon is still shutting down. Explicit cancellation is distinct.
test('disconnect after candidate publication verifies and promotes it', async t => {
  const dataDir=fs.mkdtempSync(path.join(process.env.TMPDIR,'headed-race-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const svc=createLoginService({headedDouyin:true,headedDaemonPath:fake,dataDir,verifyDouyin:async()=>({state:'online'})});
  svc.startHeadedDouyin();
  const dir=path.dirname((await waitDisplay(svc)).socket);
  fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
  assert.deepEqual(await svc.disconnectHeadedDouyin(),{state:'online'});
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir,'douyin-cookies.json'),'utf8'))[0].value,'synthetic');
  assert.equal(fs.existsSync(dir),false);
});

test('disconnect before candidate publication rejects late credentials and cleans child', async t => {
  const dataDir=fs.mkdtempSync(path.join(process.env.TMPDIR,'headed-disconnect-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const target=path.join(dataDir,'douyin-cookies.json'); fs.writeFileSync(target,'original');
  const svc=createLoginService({headedDouyin:true,headedDaemonPath:fake,dataDir});
  svc.startHeadedDouyin();
  const dir=path.dirname((await waitDisplay(svc)).socket);
  assert.deepEqual(await svc.disconnectHeadedDouyin(),{state:'expired'});
  assert.equal(fs.existsSync(dir),false);
  assert.equal(fs.readFileSync(target,'utf8'),'original');
});

test('disconnect after candidate fails verification preserves existing credentials', async t => {
  const dataDir=fs.mkdtempSync(path.join(process.env.TMPDIR,'headed-denied-'));
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  const target=path.join(dataDir,'douyin-cookies.json'); fs.writeFileSync(target,'original');
  const svc=createLoginService({headedDouyin:true,headedDaemonPath:fake,dataDir,verifyDouyin:async()=>({state:'offline'})});
  svc.startHeadedDouyin();
  const dir=path.dirname((await waitDisplay(svc)).socket);
  fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
  assert.deepEqual(await svc.disconnectHeadedDouyin(),{state:'offline'});
  assert.equal(fs.readFileSync(target,'utf8'),'original');
  assert.equal(fs.existsSync(dir),false);
});
