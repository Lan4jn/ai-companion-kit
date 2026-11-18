import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {startDaemon} from '../src/douyin-qr-daemon.js';

const browser=process.env.DOUYIN_FIXTURE_CHROME;
async function until(fn, ms=12000) {const end=Date.now()+ms; while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('fixture timeout');}
test('offline browser confirmation, verification, candidate and sanitized diagnostics', {skip:!browser,timeout:30000}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qr-fixture-')); let stage='qr'; let loads=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/state'){res.setHeader('content-type','application/json');if(stage==='complete') res.setHeader('set-cookie','sessionid=synthetic-session; Path=/');res.end(JSON.stringify({stage}));return;}
  if(req.url!=='/'){res.writeHead(404);res.end();return;} loads++;res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><div id="login-full-panel" style="width:300px;height:200px">扫码登录</div><script>setInterval(async()=>{let s=(await (await fetch('/state')).json()).stage;let d=document.querySelector('#login-full-panel');if(!d)return;if(s==='confirm')d.innerText='扫码成功 请在手机确认';if(s==='challenge')d.innerText='身份验证 接收短信验证码 短信已发送';if(s==='complete')d.remove()},100)</script>`);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); const ac=new AbortController();let job;
 try {
  job=startDaemon({sessionDir:root,url:`http://127.0.0.1:${server.address().port}/`,testChromePath:browser,installTestContext:async()=>{},delays:{initial:30,qr:30,poll:50},signal:ac.signal});
  const state=()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'status.json'))).status}catch{return ''}};
  await until(()=>state()==='waiting_modal');stage='confirm';await until(()=>state()==='confirm');
  assert.equal(fs.existsSync(path.join(root,'cookies.json')),false); assert.equal(loads,1);
  stage='challenge';await until(()=>state()==='need_sms');assert.equal(fs.existsSync(path.join(root,'cookies.json')),false);assert.equal(loads,1);
  stage='complete';await job;assert.equal(state(),'success');assert.equal(loads,1);
  const records=fs.readFileSync(path.join(root,'diagnostics.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(['confirm','challenge','candidate'].every(x=>records.some(r=>r.stage===x)));
  assert.ok(records.every(r=>Object.keys(r).sort().join(',')==='at,stage'));
  assert.ok(!JSON.stringify(records).includes('synthetic-session'));
 } finally {ac.abort();if(job)await job.catch(()=>{});await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
test('offline browser expires and refreshes without touching real accounts', {skip:!browser,timeout:30000}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qr-expiry-')); let loads=0;
 const server=http.createServer((req,res)=>{if(req.url!=='/'){res.writeHead(404);res.end();return;} loads++;res.setHeader('content-type','text/html; charset=utf-8');res.end('<div id="login-full-panel" style="width:300px;height:200px">'+(loads===1?'二维码已过期':'扫码登录')+'</div>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const ac=new AbortController();let job;
 try {job=startDaemon({sessionDir:root,url:`http://127.0.0.1:${server.address().port}/`,testChromePath:browser,installTestContext:async()=>{},delays:{initial:30,qr:30,poll:50},signal:ac.signal});await until(()=>loads>=2,15000);await new Promise(r=>setTimeout(r,12000));assert.equal(loads,2);assert.equal(JSON.parse(fs.readFileSync(path.join(root,'status.json'))).status,'waiting_modal');assert.equal(fs.existsSync(path.join(root,'cookies.json')),false);} finally {ac.abort();if(job)await job.catch(()=>{});await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
test('offline browser launch failure is reported without exception contents', {skip:!browser},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qr-fixture-'));
 try {await assert.rejects(startDaemon({sessionDir:root,testChromePath:'/nonexistent/private-token',installTestContext:async()=>{}}));const s=fs.readFileSync(path.join(root,'diagnostics.jsonl'),'utf8');assert.match(s,/browser_error/);assert.doesNotMatch(s,/private-token/);} finally {fs.rmSync(root,{recursive:true,force:true});}
});
