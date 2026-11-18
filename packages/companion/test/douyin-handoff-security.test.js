import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHandoffBridge} from '../src/douyin-handoff-bridge.js';
const {WebSocket}=createRequire(import.meta.url)('ws');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('claim is one-shot, invalid Host Origin and token fail, disconnect cancels',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-security-'));const sock=path.join(dir,'rfb.sock');
 const upstream=net.createServer(s=>s.once('data',()=>s.write('RFB 003.008\n')));await new Promise(r=>upstream.listen(sock,r));
 let disconnects=0;const svc={startHeadedDouyin:()=>({state:'starting'}),headedDouyinDisplay:()=>({socket:sock,token:'a'.repeat(64)}),disconnectHeadedDouyin:async()=>{disconnects++},cancelHeadedDouyin:async()=>{disconnects++}};
 const secret='synthetic-only-123456789012345678901234';const auth='Basic '+Buffer.from('room:'+secret).toString('base64');
 const bridge=createHandoffBridge({enabled:true,service:svc,accessToken:secret,ttlMs:3000,readyMs:1000});
 const server=http.createServer((req,res)=>{if(!bridge.handle(req,res)){res.writeHead(404);res.end()}});server.on('upgrade',(req,s,h)=>{if(!bridge.upgrade(req,s,h))s.destroy()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const connect=(origin=base,host)=>new Promise(resolve=>{const w=new WebSocket(base.replace('http:','ws:')+'/handoff/relay',{headers:{Authorization:auth,Origin:origin,...(host?{Host:host}:{})}});w.on('open',()=>resolve(w));w.on('error',()=>resolve(null));});
 const outcome=(w,token)=>new Promise(resolve=>{if(!w)return resolve('rejected');w.on('message',()=>resolve('banner'));w.on('close',()=>resolve('closed'));w.send(token);setTimeout(()=>resolve('timeout'),1000).unref()});
 try {
  assert.equal((await fetch(base+'/handoff/start',{method:'POST',headers:{Authorization:auth,Origin:'http://evil.invalid'}})).status,401);
  assert.equal(await connect('http://evil.invalid'),null);assert.equal(await connect(base,'evil.invalid'),null);
  const response=await fetch(base+'/handoff/start',{method:'POST',headers:{Authorization:auth,Origin:base}});const {token}=await response.json();
  assert.equal(await outcome(await connect(),'wrong'),'closed');
  const first=await connect();assert.equal(await outcome(first,token),'banner');
  assert.equal(await outcome(await connect(),token),'closed');
  first.close();for(let i=0;i<30&&!disconnects;i++)await pause(20);assert.equal(disconnects,1);
 } finally {await bridge.close();await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
