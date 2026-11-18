import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {createHeadedDisplay} from '../src/douyin-headed-display.js';
import {startDaemon} from '../src/douyin-qr-daemon.js';
import {installMockPinnedRoute} from './fixtures/douyin-pinned-mock-route.js';

async function until(f,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await f())return;await new Promise(r=>setTimeout(r,100));}throw Error('timed out');}
function rfb(socket,token){const s=net.createConnection(socket);let buf=Buffer.alloc(0),pending=[];function pump(){while(pending.length&&buf.length>=pending[0].n){const p=pending.shift(),b=buf.subarray(0,p.n);buf=buf.subarray(p.n);p.resolve(b);}}s.on('data',d=>{buf=Buffer.concat([buf,d]);pump();});s.on('error',()=>{for(const p of pending)p.reject(Error('RFB closed'));pending=[];});s.on('connect',()=>s.write(token+'\n'));return {s,read:n=>new Promise((resolve,reject)=>{pending.push({n,resolve,reject});pump();})};}

test('offline pinned TLS to real headed daemon with mock POST, challenge and same browser',{skip:process.env.DOUYIN_TEST_NETNS!=='1',timeout:60000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-pinned-headed-'));let display,daemon,server,privateServer,socket,context;
 const controller=new AbortController(), counts={denied:0,redirects:0,failed:0}, events=[];let privateHits=0, dnsCalls=0;
 try {
  const key=path.join(root,'key'),cert=path.join(root,'cert');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=www.douyin.com','-addext','subjectAltName=DNS:www.douyin.com'],{stdio:'ignore'});
  privateServer=http.createServer((q,r)=>{privateHits++;r.end('bad')});await new Promise(r=>privateServer.listen(0,'127.0.0.1',r));
  const privateUrl=`http://127.0.0.1:${privateServer.address().port}/`;
  server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},(req,res)=>{
   events.push({method:req.method,url:req.url,cookie:req.headers.cookie||'',remote:req.socket.remoteAddress});
   if(req.url==='/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8','set-cookie':'mock_scope=alpha; Path=/mock; Secure; HttpOnly'});res.end(`<!doctype html><style>html,body{margin:0;background:red;width:100%;height:100%}#login-full-panel{width:100%;height:100%}</style><div id="login-full-panel">扫码登录</div><script>let stage=0;onpointerup=async e=>{if(!e.isTrusted)return;if(stage++===0){await fetch('/mock/challenge',{method:'POST',body:'synthetic'});document.querySelector('#login-full-panel').innerText='安全验证';document.body.style.background='blue'}else{await fetch('/mock/redirect',{method:'POST'});try{await fetch('${privateUrl}')}catch{}await fetch('/mock/complete',{method:'POST',body:'synthetic'});document.querySelector('#login-full-panel').remove();document.body.style.background='lime'}}</script>`);}
   else if(req.url==='/mock/challenge'){res.writeHead(200,{'content-type':'text/plain'});res.end('challenge');}
   else if(req.url==='/mock/redirect'){res.writeHead(302,{location:privateUrl});res.end();}
   else if(req.url==='/mock/complete'){res.writeHead(200,{'content-type':'text/plain','set-cookie':'sessionid=synthetic-session-only; Path=/; Secure; HttpOnly; SameSite=Lax'});res.end('ok');}
   else {res.writeHead(404);res.end();}
  });await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'8.8.8.8',resolve)});
  display=await createHeadedDisplay({root,ttlMs:50000});
  daemon=startDaemon({sessionDir:root,headed:true,displayEnv:display.env,url:'https://www.douyin.com/',delays:{initial:100,qr:100,poll:100},signal:controller.signal,installTestContext:async c=>{context=c;await installMockPinnedRoute(c,{lookup:async()=>{dnsCalls++;return [{address:'8.8.8.8',family:4}]},port:server.address().port,ca:fs.readFileSync(cert)},counts);}});
  const status=()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'status.json'))).status}catch{return ''}};
  await until(()=>status()==='waiting_modal');
  const r=rfb(display.socket,display.token);socket=r.s;assert.match((await r.read(12)).toString(),/^RFB/);socket.write('RFB 003.008\n');const n=(await r.read(1))[0];assert.ok((await r.read(n)).includes(1));socket.write(Buffer.from([1]));assert.equal((await r.read(4)).readUInt32BE(),0);socket.write(Buffer.from([1]));const init=await r.read(24);await r.read(init.readUInt32BE(20));
  const click=async()=>{socket.write(Buffer.from([5,0,1,244,1,144]));await new Promise(r=>setTimeout(r,100));socket.write(Buffer.from([5,1,1,244,1,144]));await new Promise(r=>setTimeout(r,150));socket.write(Buffer.from([5,0,1,244,1,144]));};
  await new Promise(r=>setTimeout(r,1000));await click();await until(()=>status()==='need_sms');assert.equal(fs.existsSync(path.join(root,'cookies.json')),false);
  // Context remains the same; path-scoped HttpOnly cookie is not visible at '/'.
  assert.equal(await context.pages()[0].evaluate(()=>document.cookie),'');
  assert.equal((await context.cookies('https://www.douyin.com/')).some(c=>c.name==='mock_scope'),false);
  assert.equal((await context.cookies('https://www.douyin.com/mock/challenge')).some(c=>c.name==='mock_scope'),true);
  const separate = await context.browser().newContext();
  try { assert.deepEqual(await separate.cookies(), []); } finally { await separate.close(); }
  await context.pages()[0].evaluate(()=>fetch('/not-allowed').catch(()=>{}));
  await click();await daemon;assert.equal(status(),'success');
  const cookies=JSON.parse(fs.readFileSync(path.join(root,'cookies.json')));assert.ok(cookies.some(c=>c.name==='sessionid'&&c.httpOnly));
  assert.deepEqual(events.map(e=>[e.method,e.url]),[['GET','/'],['POST','/mock/challenge'],['POST','/mock/redirect'],['POST','/mock/complete']]);
  assert.ok(!events[0].cookie);assert.ok(events.slice(1).every(e=>e.cookie.includes('mock_scope=alpha')));assert.equal(dnsCalls,4);assert.equal(counts.redirects,1);assert.ok(counts.denied>=2);assert.equal(privateHits,0);assert.equal(counts.failed,0);
 } finally {controller.abort();socket?.destroy();await display?.close();if(daemon)await daemon.catch(()=>{});if(server)await new Promise(r=>server.close(r));if(privateServer)await new Promise(r=>privateServer.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
