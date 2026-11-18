import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';

const token='a'.repeat(64);
function send(socket, payload, auth=token) {return new Promise((resolve,reject)=>{let req=http.request({socketPath:socket,path:'/request',method:'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve({status:res.statusCode,body:b}));});req.on('error',reject);req.end(JSON.stringify(payload));});}
test('broker enforces method/path, pinned DNS, capability and redirect before transport',{skip:process.env.DOUYIN_TEST_NETNS!=='1',timeout:30000}, async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'broker-test-'));let server,broker;let events=[],dns=0,mixed=false;
 try {
  const key=path.join(root,'key'),cert=path.join(root,'cert'),socket=path.join(root,'s');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],{stdio:'ignore'});
  server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{events.push([req.method,req.url,req.headers.cookie||'']); if(req.url==='/redirect')res.writeHead(302,{location:'http://127.0.0.1/private','set-cookie':'leak=1'});else res.writeHead(200,{'set-cookie':'sessionid=synthetic; Path=/; Secure; HttpOnly'});res.end('ok');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  // Production rejects private DNS; map a synthetic public answer to loopback
  // only in the fixture's local TCP network namespace.
  execFileSync('ip',['addr','add','8.8.8.8/32','dev','lo']);
  await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  await new Promise(r=>server.listen(0,'8.8.8.8',r));
  broker=createCandidateBroker({token,fixturePolicy:(m,u)=>(m==='GET'&&u==='https://www.douyin.com/')||(m==='POST'&&['https://www.douyin.com/mock','https://www.douyin.com/redirect'].includes(u)),transportOptions:{port:server.address().port,ca:fs.readFileSync(cert),lookup:async()=>{dns++;return mixed?[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]:[{address:'8.8.8.8',family:4}]}}});
  await new Promise(r=>broker.server.listen(socket,r));
  const req={method:'GET',url:'https://www.douyin.com/',headers:{}};
  assert.equal((await send(socket,req,'b'.repeat(64))).status,403);
  for(const x of [{...req,url:'https://www.douyin.com/private'}, {...req,method:'POST'}, {...req,url:'https://attacker.invalid/'},{...req,headers:{host:'attacker.invalid'}}, {...req,headers:{origin:'https://attacker.invalid'}}])assert.equal((await send(socket,x)).status,403);
  assert.equal(events.length,0);
  let good=await send(socket,req);assert.equal(good.status,200);assert.match(good.body,/sessionid=synthetic/);
  let redirect=await send(socket,{method:'POST',url:'https://www.douyin.com/redirect',headers:{cookie:'x=1'}});assert.equal(redirect.status,403);assert.doesNotMatch(redirect.body,/leak|127\.0\.0\.1/);
  mixed=true;assert.equal((await send(socket,req)).status,403);assert.equal(dns,3);assert.deepEqual(events.map(e=>e.slice(0,2)),[['GET','/'],['POST','/redirect']]);
 } finally {await broker?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
