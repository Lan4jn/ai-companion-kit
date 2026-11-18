import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createCandidateBroker} from '../src/douyin-request-broker-candidate.js';

test('closing broker aborts an in-flight upstream TLS request', {skip:process.env.DOUYIN_TEST_NETNS!=='1',timeout:15000}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-cancel-'));
 let server,broker,upstream;
 try {
  const key=path.join(dir,'key'),cert=path.join(dir,'cert'),socket=path.join(dir,'s');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],{stdio:'ignore'});
  let arrived; const requestArrived=new Promise(r=>arrived=r);
  server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{upstream=res;arrived();});
  await new Promise(r=>server.listen(0,'8.8.8.8',r));
  broker=createCandidateBroker({token:'a'.repeat(64),policy:{hosts:['www.douyin.com'],routes:[{host:'www.douyin.com',method:'GET',path:'/'}]},transportOptions:{port:server.address().port,ca:fs.readFileSync(cert),lookup:async()=>[{address:'8.8.8.8',family:4}],timeoutMs:8000}});
  await new Promise(r=>broker.server.listen(socket,r));
  const req=http.request({socketPath:socket,path:'/request',method:'POST',headers:{authorization:'Bearer '+ 'a'.repeat(64)}},res=>res.resume());
  req.on('error',()=>{}); req.end(JSON.stringify({method:'GET',url:'https://www.douyin.com/',headers:{}}));
  await requestArrived;
  const upstreamClosed=new Promise(r=>upstream.once('close',()=>r(true)));
  await broker.close();
  assert.equal(await Promise.race([upstreamClosed,new Promise(r=>setTimeout(()=>r(false),500))]),true,'upstream socket remained open after cancellation');
 } finally {upstream?.destroy();await broker?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
