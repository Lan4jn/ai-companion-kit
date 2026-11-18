import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {startDaemon} from '../src/douyin-qr-daemon.js';
const browser=process.env.DOUYIN_FIXTURE_CHROME;
test('refresh publishes a replacement QR and invalidates the old image', {skip:!browser,timeout:30000}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qr-replacement-'));let loads=0;
 const server=http.createServer((req,res)=>{loads++;res.setHeader('content-type','text/html; charset=utf-8');res.end(loads===1?'<div id="login-full-panel" style="width:300px;height:200px">二维码已过期</div>':'<div id="login-full-panel" style="width:300px;height:200px">扫码登录<img style="width:160px;height:160px" src="data:image/png;base64,c3ludGhldGlj"></div>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const ac=new AbortController();let job;
 try {
  fs.writeFileSync(path.join(root,'qr.png'),'old');
  job=startDaemon({sessionDir:root,url:`http://127.0.0.1:${server.address().port}/`,testChromePath:browser,installTestContext:async()=>{},delays:{initial:30,qr:30,poll:50},signal:ac.signal});
  const end=Date.now()+20000;let state='';
  while(Date.now()<end){try{state=JSON.parse(fs.readFileSync(path.join(root,'status.json'))).status;}catch{} if(state==='refreshing')assert.equal(fs.existsSync(path.join(root,'qr.png')),false);if(loads>=2&&state==='ready')break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(state,'ready');assert.equal(fs.readFileSync(path.join(root,'qr.png'),'utf8'),'synthetic');assert.equal(fs.existsSync(path.join(root,'cookies.json')),false);
 }finally{ac.abort();if(job)await job.catch(()=>{});await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
