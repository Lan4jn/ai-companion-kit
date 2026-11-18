import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fork} from 'node:child_process';
import {chromium} from 'playwright-core';
import {createLoginService} from '../src/room-login-service.js';
import {createHandoffBridge} from '../src/douyin-handoff-bridge.js';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('synthetic browser controls the same headed login through the actual bridge', {timeout:90000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'handoff-e2e-'));
 let fixture,server,browser,bridge,visits=0,steps=0;
 try {
 fixture=http.createServer((req,res)=>{if(req.url==='/step'){steps++;res.end();return}visits++;res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><style>html,body{margin:0;background:red;width:100%;height:100%}#login-full-panel{width:100%;height:100%}</style><div id="login-full-panel">扫码登录</div><script>let stage=0;onpointerup=e=>{if(!e.isTrusted)return;fetch('/step');if(stage++===0){document.querySelector('#login-full-panel').innerText='安全验证';document.body.style.background='blue'}else{document.cookie='sessionid=synthetic; path=/';document.querySelector('#login-full-panel').remove();document.body.style.background='lime'}}</script>`)});
 await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
 const svc=createLoginService({headedDouyin:true,dataDir:root,headedDaemonPath:path.resolve('test/fixtures/douyin-handoff-daemon.js'),forkHeaded:(f,a,o)=>fork(f,a,{...o,env:{...o.env,SYNTHETIC_URL:`http://127.0.0.1:${fixture.address().port}/`}}),verifyDouyin:async()=>({state:'online'})});
 const secret='synthetic-only-123456789012345678901234';
 bridge=createHandoffBridge({enabled:true,accessToken:secret,service:svc,ttlMs:80000,readyMs:15000});
 server=http.createServer((req,res)=>{if(!bridge.handle(req,res)){res.writeHead(404);res.end()}});
 server.on('upgrade',(req,socket,head)=>{if(!bridge.upgrade(req,socket,head))socket.destroy()});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/handoff')).status,401);
 const auth='Basic '+Buffer.from('room:'+secret).toString('base64');
 assert.equal((await fetch(base+'/handoff/start',{method:'POST',headers:{authorization:auth,origin:'http://evil.invalid'}})).status,401);
 browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
 const context=await browser.newContext({httpCredentials:{username:'room',password:secret},viewport:{width:1024,height:850}});
 // A 401 challenge populates Chromium's authentication cache for WebSocket.
 const page=await context.newPage();page.on('pageerror',e=>console.error('viewer error',e.message));
 await page.goto(base+'/handoff');await page.locator('#start').click();
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='ready',null,{timeout:20000});
 for(let i=0;i<100&&!visits;i++)await wait(100); assert.ok(visits,'synthetic page was never visited');
 const pixel=async rgb=>{try {await page.waitForFunction(rgb=>{const d=document.querySelector('canvas').getContext('2d').getImageData(400,400,1,1).data;return rgb.every((n,i)=>d[i]===n)},rgb,{timeout:12000});} catch(e) {console.error('synthetic pixel',await page.evaluate(()=>Array.from(document.querySelector('canvas').getContext('2d').getImageData(400,400,1,1).data)),await page.locator('#status').textContent());throw e}};
 await pixel([255,0,0]);await page.locator('canvas').click({position:{x:400,y:400}});for(let i=0;i<100&&!steps;i++)await wait(100);assert.equal(steps,1);await wait(1500);
 await page.locator('canvas').click({position:{x:400,y:400}});
 for(let i=0;i<200&&!fs.existsSync(path.join(root,'douyin-cookies.json'));i++)await wait(100);
 assert.equal(steps,2,'both clicks must reach same fixture');assert.equal(fs.existsSync(path.join(root,'douyin-cookies.json')),true);
 await context.close();
 } finally {await browser?.close();await bridge?.close();if(server)await new Promise(r=>server.close(r));if(fixture)await new Promise(r=>fixture.close(r));fs.rmSync(root,{recursive:true,force:true});}
});
