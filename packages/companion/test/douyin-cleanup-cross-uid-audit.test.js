import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createLoginService} from '../src/room-login-service.js';

// An independent worker survives the supervised child, as a detached descendant
// might; it only receives directory FDs and runs under a different UID.
test('cross-UID concurrent directory/symlink swaps cannot redirect headed cleanup', {skip:process.getuid?.() !== 0, timeout:30000}, async t=>{
  const base=fs.mkdtempSync(path.join('/run','headed-cleanup-audit-'));
  const root=path.join(base,'sessions'), victim=path.join(base,'victim');
  fs.chmodSync(base,0o711);
  fs.mkdirSync(victim,{mode:0o777}); fs.chmodSync(victim,0o777);
  const sentinel=path.join(victim,'sentinel'); fs.writeFileSync(sentinel,'preserve');
  let attacker, child, dir;
  t.after(()=>{try {attacker?.kill('SIGKILL')} catch {} try {child?.kill('SIGKILL')} catch {} fs.rmSync(base,{recursive:true,force:true});});
  let ready;
  const svc=createLoginService({dataDir:base,headedSessionRoot:root,headedDouyin:true,headedKillMs:200,
    forkHeaded:(_file,_args,options)=>{
      dir=options.env.DOUYIN_LOGIN_SESSION_DIR; fs.chownSync(dir,65534,65534);
      fs.mkdirSync(path.join(dir,'slot')); fs.chownSync(path.join(dir,'slot'),65534,65534);
      for(let i=0;i<500;i++) fs.writeFileSync(path.join(dir,'slot',`f${i}`),'x');
      const fd=fs.openSync(dir,'r');
      const code=`const fs=require('fs'),p='/proc/self/fd/3';let count=0,swaps=0;function run(){for(let i=0;i<100;i++){try{fs.renameSync(p+'/slot',p+'/held')}catch{};try{fs.symlinkSync(process.env.VICTIM,p+'/slot');swaps++}catch{};try{fs.unlinkSync(p+'/slot')}catch{};try{fs.renameSync(p+'/held',p+'/slot')}catch{};count++} if(count===100)process.send({uid:process.getuid(),swaps});setImmediate(run)}run()`;
      attacker=spawn(process.execPath,['-e',code],{uid:65534,gid:65534,stdio:['ignore','ignore','ignore',fd,'ipc'],env:{VICTIM:victim}}); fs.closeSync(fd);
      ready=new Promise((resolve,reject)=>{attacker.once('message',resolve);attacker.once('error',reject);attacker.once('exit',()=>reject(Error('attacker exited before readiness')))});
      child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); return child;
    }});
  assert.equal(svc.startHeadedDouyin().state,'starting');
  const before=fs.statSync(root); const observed=await ready;
  assert.equal(observed.uid,65534); assert.ok(observed.swaps>0,'attacker must successfully replace a directory with a symlink');
  await svc.cancelHeadedDouyin();
  assert.equal(fs.readFileSync(sentinel,'utf8'),'preserve');
  const after=fs.statSync(root); assert.equal(after.uid,before.uid); assert.equal(after.mode,before.mode);
  assert.ok(!fs.existsSync(dir) || fs.lstatSync(dir).isDirectory());
});
