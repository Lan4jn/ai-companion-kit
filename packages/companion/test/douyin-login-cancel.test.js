import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createLoginService} from '../src/room-login-service.js';

test('cancelling an in-flight candidate invalidates it and preserves existing credentials', async t => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'douyin-cancel-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'douyin-cookies.json'),'existing');
  let sessionDir, killed=false, unblock;
  const service=createLoginService({dataDir:dir,spawnLogin:(_c,_a,opts)=>{
    sessionDir=opts.env.DOUYIN_LOGIN_SESSION_DIR;
    const child=new EventEmitter(); child.exitCode=null; child.kill=()=>{killed=true}; return child;
  },verifyDouyin:()=>new Promise(resolve=>{unblock=resolve})});
  service.startDouyin();
  fs.writeFileSync(path.join(sessionDir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
  fs.writeFileSync(path.join(sessionDir,'status.json'),JSON.stringify({status:'success'}));
  const pending=service.douyinProgress();
  assert.equal(service.cancelDouyin().state,'expired');
  unblock({state:'online'});
  assert.equal((await pending).state,'expired');
  assert.equal(fs.readFileSync(path.join(dir,'douyin-cookies.json'),'utf8'),'existing');
  assert.equal(fs.existsSync(sessionDir),false);
  assert.equal(killed,true);
});
