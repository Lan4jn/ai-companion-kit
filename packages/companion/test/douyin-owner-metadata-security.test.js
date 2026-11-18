import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, fork} from 'node:child_process';
import {createLoginService} from '../src/room-login-service.js';

for (const attack of ['symlink','hardlink','race']) test(`worker ${attack} cannot redirect owner metadata onto service files`, {skip:process.getuid?.() !== 0}, async t=>{
  const base=fs.mkdtempSync(path.join(process.env.TMPDIR,'owner-regression-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'sessions'), victim=path.join(base,'victim');
  fs.writeFileSync(victim,'DO NOT OVERWRITE'); fs.chmodSync(base,0o711); fs.chmodSync(victim,0o666);
  let dir;
  const worker=`const fs=require('fs'); const p='/proc/self/fd/3'; try{fs.unlinkSync(p+'/.owner.json')}catch(e){if(e.code!=='ENOENT')throw e}; const replace=()=>{try{fs.unlinkSync(p+'/.owner.json')}catch{}; try{if(process.env.ATTACK==='hardlink') fs.linkSync('/proc/self/fd/4/victim',p+'/.owner.json'); else fs.symlinkSync(process.env.TARGET,p+'/.owner.json')}catch(e){if(process.env.ATTACK==='hardlink')throw e}}; replace(); if(process.env.ATTACK==='race')setInterval(replace,1); process.send({type:'display',socket:process.env.SOCKET,token:'a'.repeat(64)}); setInterval(()=>{},1000);`;
  let ready;
  const service=createLoginService({dataDir:base,headedSessionRoot:root,headedDouyin:true,
    forkHeaded:(_f,_a,o)=>{dir=o.env.DOUYIN_LOGIN_SESSION_DIR;fs.chownSync(dir,65534,65534);const fd=fs.openSync(dir,'r'), baseFd=fs.openSync(base,'r');const child=spawn(process.execPath,['-e',worker],{uid:65534,gid:65534,detached:true,stdio:['ignore','ignore','ignore',fd,baseFd,'ipc'],env:{TARGET:victim,ATTACK:attack,SOCKET:path.join(dir,'display.sock')}});fs.closeSync(fd);fs.closeSync(baseFd);ready=new Promise(r=>child.once('message',r));return child;},
    forkVerifier:(...a)=>fork(path.resolve('test/fixtures/douyin-verifier-hang.js'),a[1],a[2]), headedVerifyMs:100});
  assert.equal(service.startHeadedDouyin().state,'starting'); await ready;
  fs.writeFileSync(path.join(dir,'cookies.json'),JSON.stringify([{name:'sessionid',value:'synthetic'}]));
  fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
  await service.headedDouyinProgress();
  assert.equal(fs.readFileSync(victim,'utf8'),'DO NOT OVERWRITE');
});
