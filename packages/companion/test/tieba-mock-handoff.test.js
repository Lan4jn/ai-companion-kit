import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { createTiebaMockHandoff } from '../src/tieba-mock-handoff.js';
import { createTiebaReader } from '../src/tieba-reader.js';

const pause = ms => new Promise(r => setTimeout(r, ms));
test('disabled by default', () => { const h = createTiebaMockHandoff(); assert.equal(h.source, null); assert.equal(h.status(), 'unknown'); });
test('mock web viewer trusted click shares identity and reader context; disconnect revokes', { timeout: 60000 }, async () => {
 const root = await mkdtemp(join(process.env.TMPDIR, 'tieba-handoff-'));
 const token='synthetic-only-123456789012345678901234';
 const h=createTiebaMockHandoff({enabled:true,root,accessToken:token,ttlMs:50000,readyMs:20000});
 const server=http.createServer((req,res)=>{if(!h.handle(req,res)){res.writeHead(404);res.end()}});
 server.on('upgrade',(req,socket,head)=>{if(!h.upgrade(req,socket,head))socket.destroy()});
 let browser;
 try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/handoff')).status,401);
  const auth='Basic '+Buffer.from('room:'+token).toString('base64');
  assert.equal((await fetch(base+'/handoff/start',{method:'POST',headers:{authorization:auth,origin:'http://evil.invalid'}})).status,401);
  let prompts=0; const reader=createTiebaReader({enabled:true,source:h.source,dir:root,brain:{complete:async()=>{prompts++;return JSON.stringify({action:'continue',record:false,keywords:[]})}}});
  assert.equal((await reader.run()).status,'source_failed');
  browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
  const context=await browser.newContext({httpCredentials:{username:'room',password:token},viewport:{width:1024,height:850}});const page=await context.newPage();
  await page.goto(base+'/handoff'); assert.match(await page.title(),/贴吧模拟/); await page.locator('#start').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='ready',null,{timeout:25000});
  assert.equal(await page.evaluate(async()=> (await fetch('/handoff/start',{method:'POST'})).status),409);
  await pause(1200); await page.locator('canvas').click({position:{x:400,y:400}});
  let result; for(let i=0;i<50;i++){result=await reader.run();if(result.status==='completed')break;await pause(100)}
  assert.deepEqual(result,{status:'completed',read:1,saved:0}); assert.equal(prompts,1); assert.equal(h.status(),'unknown');
  await context.close(); for(let i=0;i<50;i++){if((await reader.run()).status==='source_failed')break;await pause(100)}
  assert.equal((await reader.run()).status,'source_failed');
 } finally {await browser?.close();await h.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
});
