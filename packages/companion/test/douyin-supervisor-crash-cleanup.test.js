import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createLoginService} from '../src/room-login-service.js';

const tick=()=>new Promise(r=>setTimeout(r,30));
test('SIGKILL must discard even a published candidate and clean only its own directory',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'headed-crash-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let child,dir;
 const svc=createLoginService({headedDouyin:true,headedSessionRoot:root,forkHeaded(_p,_a,o){dir=o.env.DOUYIN_LOGIN_SESSION_DIR;child=new EventEmitter();child.kill=()=>true;return child;}});
 assert.equal(svc.startHeadedDouyin().state,'starting');
 fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify({status:'success'}));
 child.emit('exit',null,'SIGKILL'); await tick();
 assert.equal(fs.existsSync(dir),false);
});
test('replaced session symlink is never followed or removed',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'headed-symlink-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let child,dir;const other=path.join(root,'other');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'sentinel'),'keep');
 const svc=createLoginService({headedDouyin:true,headedSessionRoot:root,forkHeaded(_p,_a,o){dir=o.env.DOUYIN_LOGIN_SESSION_DIR;child=new EventEmitter();child.kill=()=>true;return child;}});
 svc.startHeadedDouyin();fs.renameSync(dir,dir+'-original');fs.symlinkSync(other,dir);child.emit('exit',null,'SIGKILL');await tick();
 assert.equal(fs.readFileSync(path.join(other,'sentinel'),'utf8'),'keep');assert.ok(fs.lstatSync(dir).isSymbolicLink());
});

test('replaced session path is not removed during crash cleanup',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'headed-replace-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let child,dir;
 const svc=createLoginService({headedDouyin:true,headedSessionRoot:root,forkHeaded(_p,_a,o){dir=o.env.DOUYIN_LOGIN_SESSION_DIR;child=new EventEmitter();child.kill=()=>true;return child;}});
 svc.startHeadedDouyin();fs.renameSync(dir,dir+'-original');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'sentinel'),'keep');
 child.emit('exit',null,'SIGKILL');await tick();
 assert.equal(fs.readFileSync(path.join(dir,'sentinel'),'utf8'),'keep');
});
