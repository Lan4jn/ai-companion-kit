import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fork,execFileSync} from 'node:child_process';
import {createLoginService} from '../src/room-login-service.js';
import {createHandoffBridge} from '../src/douyin-handoff-bridge.js';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(50)}throw Error('condition timed out')}
function processes(){return execFileSync('ps',['-eo','pid=,ppid=,pgid=,stat=,comm='],{encoding:'utf8'}).trim().split('\n').map(s=>{const [pid,ppid,pgid,stat,comm]=s.trim().split(/\s+/);return {pid:+pid,ppid:+ppid,pgid:+pgid,stat,comm}})}
function descendants(pid){const all=processes(), ids=new Set([pid]);let changed=true;while(changed){changed=false;for(const p of all)if(ids.has(p.ppid)&&!ids.has(p.pid)){ids.add(p.pid);changed=true}}return all.filter(p=>ids.has(p.pid)&&!p.stat.startsWith('Z'))}
async function cleanupChecked(pid,dir,captured){await until(()=>!fs.existsSync(dir));await until(()=>{const all=processes();return !all.some(p=>(captured.some(c=>c.pid===p.pid)||p.pgid===pid)&&!p.stat.startsWith('Z'))},10000)}
const secret='synthetic-only-123456789012345678901234';
test('real Chromium bridge lifecycle: duplicate, cancel, expiry and descendant cleanup',{timeout:120000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-lifecycle-')); let fixture,server,bridge,svc,child,visits=0;
 try {
  fixture=http.createServer((req,res)=>{visits++;res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><div id="login-full-panel">扫码登录</div>')});await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
  svc=createLoginService({headedDouyin:true,dataDir:root,headedDaemonPath:path.resolve('test/fixtures/douyin-handoff-daemon.js'),forkHeaded:(f,a,o)=>child=fork(f,a,{...o,env:{...o.env,SYNTHETIC_URL:`http://127.0.0.1:${fixture.address().port}/`}}),verifyDouyin:async()=>({state:'online'})});
  bridge=createHandoffBridge({enabled:true,accessToken:secret,service:svc,ttlMs:9000,readyMs:7000});server=http.createServer((req,res)=>{if(!bridge.handle(req,res)){res.writeHead(404);res.end()}});server.on('upgrade',(req,s,h)=>{if(!bridge.upgrade(req,s,h))s.destroy()});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,headers={Authorization:'Basic '+Buffer.from('room:'+secret).toString('base64'),Origin:base};const post=p=>fetch(base+p,{method:'POST',headers});
  async function launch(){const prior=visits;assert.equal((await post('/handoff/start')).status,200);const display=await until(()=>svc.headedDouyinDisplay());const dir=path.dirname(display.socket);await until(()=>descendants(child.pid).some(p=>/chrome|chromium/i.test(p.comm)));await until(()=>visits>prior);await pause(500);return {pid:child.pid,dir,procs:descendants(child.pid)}}
  await t.test('duplicate start and cancel wait for real browser cleanup',async()=>{const s=await launch();assert.equal((await post('/handoff/start')).status,409);assert.equal((await post('/handoff/cancel')).status,204);await cleanupChecked(s.pid,s.dir,s.procs);await svc.cancelHeadedDouyin();assert.equal(fs.existsSync(path.join(root,'douyin-cookies.json')),false)});
  await t.test('unclaimed session expires and cleans browser descendants',async()=>{const s=await launch();await cleanupChecked(s.pid,s.dir,s.procs);assert.equal((await svc.headedDouyinProgress()).state,'expired')});
 } finally {await bridge?.close();if(server)await new Promise(r=>server.close(r));if(fixture)await new Promise(r=>fixture.close(r));fs.rmSync(root,{recursive:true,force:true})}
});

test('disabled bridge rejects HTTP and upgrade without invoking service',async()=>{let calls=0;const svc=new Proxy({}, {get:()=>()=>{calls++;throw Error('unexpected service invocation')}});const bridge=createHandoffBridge({enabled:false,service:svc});assert.equal(bridge.handle({url:'/handoff/start',method:'POST'},{}),false);assert.equal(bridge.upgrade({url:'/handoff/relay'},{},Buffer.alloc(0)),false);await bridge.close();assert.equal(calls,0)});
