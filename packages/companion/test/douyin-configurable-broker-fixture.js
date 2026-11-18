// Offline-only helper for test/douyin-inherited-broker-isolation.py.
import fs from 'node:fs';
import https from 'node:https';
import { chromium } from 'playwright-core';
import { createCandidateBroker } from '../src/douyin-request-broker-candidate.js';
import { createInheritedBrokerClient } from '../src/douyin-inherited-broker-client.js';
import { installCandidateBrokerRoute } from '../src/douyin-broker-route-candidate.js';
import assert from 'node:assert/strict';

if (['broker','headedbroker'].includes(process.argv[2])) {
  const dir=process.argv[3], fd=Number(process.argv[4]);
  const server=https.createServer({key:fs.readFileSync(dir+'/key'),cert:fs.readFileSync(dir+'/cert')},(req,res)=>{
    if(req.url==='/' && process.argv[2]==='headedbroker') {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<style>html,body,#login-full-panel{margin:0;width:100%;height:100%}</style><div id="login-full-panel">扫码登录</div><script>let n=0;onpointerup=async e=>{if(!e.isTrusted)return;if(n++===0){await fetch('/challenge',{method:'POST'});document.querySelector('#login-full-panel').textContent='安全验证'}else{await fetch('/redirect',{method:'POST'}).catch(()=>{});await fetch('/complete',{method:'POST'});document.querySelector('#login-full-panel').remove()}}</script>`);}
    else if(req.url==='/') {res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<script src="/resource.js"></script><button id="login">扫码登录</button><script>login.onclick=async()=>{await fetch('/challenge',{method:'POST'});login.textContent='安全验证';login.onclick=async()=>{await fetch('/complete',{method:'POST'});login.textContent='登录成功'}}</script>`);}
    else if(req.url==='/resource.js'){res.writeHead(200,{'content-type':'application/javascript'});res.end('window.resourceLoaded=true');}
    else if(req.url==='/challenge'){res.end('challenge');}
    else if(req.url==='/complete'){res.writeHead(200,{'set-cookie':'sessionid=fixture; Path=/; Secure; HttpOnly'});res.end('ok');}
    else if(req.url==='/redirect'){res.writeHead(302,{location:'http://127.0.0.1/'});res.end();}
    else {res.writeHead(500);res.end();}
  });
  await new Promise(r=>server.listen(0,'8.8.8.8',r));
  const broker=createCandidateBroker({inheritedFd:fd,policy:{hosts:['login.example.test'],routes:[...['/','/resource.js'].map(path=>({host:'login.example.test',method:'GET',path})),...['/challenge','/complete','/redirect'].map(path=>({host:'login.example.test',method:'POST',path}))]},transportOptions:{lookup:async()=>[{address:'8.8.8.8',family:4}],port:server.address().port,ca:fs.readFileSync(dir+'/cert')}});
  console.log('READY '+server.address().port);
  process.on('SIGTERM',async()=>{await broker.close();server.close();});
} else {
  const client=createInheritedBrokerClient(3);
  console.log('CLIENT_READY');
  await new Promise(resolve => process.stdin.once('data',resolve));
  const net = await import('node:net');
  const raw = await new Promise(resolve => { const s=net.connect({host:'8.8.8.8',port:Number(process.argv[4])}); s.setTimeout(1000,()=>{s.destroy();resolve(false)}); s.on('connect',()=>{s.destroy();resolve(true)}); s.on('error',()=>resolve(false)); });
  assert.equal(raw,false,'raw network must be unreachable');
  const browser=await chromium.launch({executablePath:process.argv[3],headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try {
    const context=await browser.newContext({serviceWorkers:'block'});
    await installCandidateBrokerRoute(context,{brokerClient:client});
    const page=await context.newPage();
    await page.goto('https://login.example.test/');
    assert.equal(await page.evaluate(()=>window.resourceLoaded),true);
    await page.locator('#login').click();
    await page.getByText('安全验证').waitFor();
    assert.deepEqual(await context.cookies(),[]);
    await page.locator('#login').click();
    await page.getByText('登录成功').waitFor();
    assert.equal((await context.cookies()).find(x=>x.name==='sessionid')?.value,'fixture');
    assert.equal(await page.evaluate(async()=> (await fetch('/redirect',{method:'POST'})).status),403);
    assert.equal((await client.request({url:'https://login.example.test/redirect',method:'POST',headers:{}}).then(()=>200,()=>403)),403);
    assert.equal((await client.request({url:'https://login.example.test/not-allowed',method:'GET',headers:{}}).then(()=>200,()=>403)),403);
    assert.equal((await client.request({url:'https://login.example.test/complete',method:'POST',headers:{},body:Buffer.alloc(4097).toString('base64')}).then(()=>200,()=>403)),403);
    assert.equal((await client.request({url:'http://127.0.0.1/',method:'GET',headers:{}}).then(()=>200,()=>403)),403);
    console.log('PASS: same Chromium challenge/login, cookie, redirect and private target denied');
    await context.close();
  } finally {await browser.close();client.close();}
}
