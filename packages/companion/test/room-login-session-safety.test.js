import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createLoginService } from '../src/room-login-service.js';

test('隔离扫码会话，验证失败不覆盖原凭据且清除二维码', async t => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'login-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const target=path.join(dir,'douyin-cookies.json');
  fs.writeFileSync(target,'old');
  const children=[];
  const spawnLogin=(_cmd,_args,opts)=>{const child=new EventEmitter(); child.exitCode=null; child.kill=()=>{}; children.push({child,env:opts.env});return child;};
  const svc=createLoginService({dataDir:dir,spawnLogin,verifyDouyin:async()=>({state:'unknown'})});
  svc.startDouyin();
  const session=children[0].env.DOUYIN_LOGIN_SESSION_DIR;
  assert.ok(session && session !== dir);
  fs.writeFileSync(path.join(session,'qr.png'),'fake');
  fs.writeFileSync(path.join(session,'cookies.json'),JSON.stringify([{name:'sessionid',value:'candidate'}]));
  fs.writeFileSync(path.join(session,'status.json'),JSON.stringify({status:'success'}));
  assert.equal((await svc.douyinProgress()).state,'unknown');
  assert.equal(fs.readFileSync(target,'utf8'),'old');
  assert.equal(svc.douyinPng(),null);
  assert.equal(fs.existsSync(session),false);
});

test('验证通过才私有原子替换，退出和风控清理会话', async t => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'login-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const children=[];
  const spawnLogin=(_c,_a,opts)=>{const child=new EventEmitter();child.exitCode=null;child.kill=()=>{};children.push({child,dir:opts.env.DOUYIN_LOGIN_SESSION_DIR});return child;};
  const svc=createLoginService({dataDir:dir,spawnLogin,verifyDouyin:async()=>({state:'online'})});
  svc.startDouyin();
  const first=children[0];
  fs.writeFileSync(path.join(first.dir,'qr.png'),'fake');
  fs.writeFileSync(path.join(first.dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'test'}]));
  fs.writeFileSync(path.join(first.dir,'status.json'),JSON.stringify({status:'success'}));
  assert.equal((await svc.douyinProgress()).state,'online');
  assert.equal(fs.statSync(path.join(dir,'douyin-cookies.json')).mode & 0o777,0o600);
  assert.equal(fs.existsSync(first.dir),false);
  svc.startDouyin();
  const second=children[1];
  assert.notEqual(first.dir,second.dir);
  fs.writeFileSync(path.join(second.dir,'qr.png'),'fake');
  fs.writeFileSync(path.join(second.dir,'status.json'),JSON.stringify({status:'need_sms'}));
  second.child.exitCode=1;
  assert.equal((await svc.douyinProgress()).state,'risk');
  assert.equal(fs.existsSync(second.dir),false);
  svc.startDouyin();
  const third=children[2];
  third.child.exitCode=1; third.child.emit('exit',1);
  assert.equal((await svc.douyinProgress()).state,'unknown');
  assert.equal(fs.existsSync(third.dir),false);
});

test('B站轮询风控终态销毁二维码', async () => {
  let calls=0;
  const svc=createLoginService({makeQrImage:async()=>Buffer.from('fake'),fetcher:async()=>++calls===1 ? {ok:true,json:async()=>({code:0,data:{url:'https://www.bilibili.com/login',qrcode_key:'key'}})} : {status:403,ok:false}});
  assert.equal((await svc.startBili()).state,'waiting');
  assert.ok(svc.biliPng());
  assert.equal((await svc.pollBili()).state,'risk');
  assert.equal(svc.biliPng(),null);
});
