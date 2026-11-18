import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {chromium} from 'playwright-core';

const html=fs.readFileSync(new URL('../src/douyin-handoff-viewer.html',import.meta.url));
test('viewer retries after relay disconnect and cancellation racing start', {timeout:30000},async()=>{
 let starts=0,cancels=0,releaseStart,connections=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/handoff/start'){
   starts++;
   const finish=()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({token:'synthetic'}))};
   if(starts===3)releaseStart=finish;else finish();return;
  }
  if(req.url==='/handoff/cancel'){cancels++;res.writeHead(204);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);
 });
 const wss=new WebSocketServer({server});
 wss.on('connection',ws=>{connections++;ws.once('message',()=>ws.close());});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
  const context=await browser.newContext();const base=`http://127.0.0.1:${server.address().port}`;
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/handoff');
  for(let i=1;i<=2;i++){
   await page.locator('#start').click();
   for(let j=0;j<500&&connections<i;j++)await new Promise(r=>setTimeout(r,10));
   assert.equal(connections,i);
   await page.waitForFunction(()=>document.querySelector('#status').textContent==='已断开，可重新开始' && !document.querySelector('#start').disabled, null, {timeout:10000});
  }
  await page.locator('#start').click();
  for(let i=0;i<100&&!releaseStart;i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(releaseStart);await page.locator('#cancel').click();
  releaseStart();await page.waitForFunction(()=>!document.querySelector('#start').disabled);
  assert.equal(connections,2);assert.equal(cancels,2);assert.deepEqual(errors,[]);
 } finally {await browser?.close();wss.close();await new Promise(r=>server.close(r));}
});
