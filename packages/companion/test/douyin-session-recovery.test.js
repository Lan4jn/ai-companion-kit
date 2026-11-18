import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLoginService} from '../src/room-login-service.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('startup removes only marked dead sessions and ignores active or symlink entries',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-cleanup-fixture-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const target=path.join(root,'outside');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'keep'),'synthetic');
 const sessions=path.join(root,'sessions');fs.mkdirSync(sessions,{mode:0o700});
 for(const [name,pid] of [['dead',2147483647],['live',process.pid]]) {const d=path.join(sessions,'session-'+name);fs.mkdirSync(d);const st=fs.statSync(d);fs.writeFileSync(path.join(sessions,`session-${name}.owner.json`),JSON.stringify({owner:pid,child:pid,identity:{dev:st.dev,ino:st.ino}}));}
 const legacy=path.join(sessions,'session-legacy');fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'.owner.json'),JSON.stringify({owner:2147483647,child:2147483647}));
 fs.symlinkSync(target,path.join(sessions,'session-link'));
 createLoginService({headedSessionRoot:sessions});
 assert.equal(fs.existsSync(path.join(sessions,'session-dead')),false);
 assert.equal(fs.existsSync(path.join(sessions,'session-live')),true);
 assert.equal(fs.existsSync(legacy),true);
 assert.equal(fs.existsSync(path.join(target,'keep')),true);
 assert.equal(fs.lstatSync(path.join(sessions,'session-link')).isSymbolicLink(),true);
});
test('crashed parent retains a session while its detached child is alive',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-crash-fixture-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const owner=spawn(process.execPath,[path.resolve('test/fixtures/douyin-session-owner.js'),root],{stdio:['ignore','pipe','ignore']});
 const [chunk]=await once(owner.stdout,'data');const {dir,pid}=JSON.parse(String(chunk));
 t.after(()=>{try{process.kill(-pid,'SIGKILL');}catch{}});
 const exited=once(owner,'exit');owner.kill('SIGKILL');await exited;
 createLoginService({headedSessionRoot:root});
 assert.equal(fs.existsSync(dir),true);
});
