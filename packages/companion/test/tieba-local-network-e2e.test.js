import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createOwnerTiebaSessionFactory, createTiebaLoginIntegration } from '../src/tieba-login-integration.js';
import { createTiebaReader } from '../src/tieba-reader.js';
import { startVirtualRoomServer } from '../src/virtual-room.js';

const url='https://tieba.baidu.com/p/123';
const html='<div class="forum-name-main">肥鱼避难所</div><div class="forum-name-suffix">吧</div><div class="center-content"><div class="image-text"><div class="pb-title">可爱的橘猫</div><div class="pb-content-wrap"><div tid="123">这只橘猫很可爱</div></div><div class="desc-info"><span class="post-num">2026-01-01</span></div></div></div>';
test('real loopback network, isolated Chromium owner action, identity, controlled HTML and reader', async t => {
 let valid=true, threadHits=0, browser;
 const server=http.createServer((req,res)=>{
   if(req.url==='/login') { res.writeHead(200,{'content-type':'text/html'});res.end('<button onclick="fetch(\'/signin\',{method:\'POST\'})">owner</button>');return; }
   if(req.url==='/signin' && req.method==='POST') {res.writeHead(200,{'set-cookie':'synthetic=fixture-secret; HttpOnly; SameSite=Strict; Path=/'});res.end('ok');return;}
   const logged=valid && req.headers.cookie==='synthetic=fixture-secret';
   if(req.url==='/identity') {res.writeHead(logged?200:401);res.end(logged?'fixture-online':'unknown');return;}
   if(req.url==='/p/123') {threadHits++;res.writeHead(logged?200:401,{'content-type':'text/html'});res.end(logged?html:'unknown');return;}
   res.writeHead(404);res.end();
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 const dir=await mkdtemp(join(process.env.TMPDIR,'tieba-local-e2e-'));
 let context;
 const createSession=createOwnerTiebaSessionFactory({enabled:true,ttlMs:30000,openOwnerSession:async()=>{
   browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
   context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
   const page=await context.newPage();await page.goto(base+'/login');const response=page.waitForResponse(r=>r.url()===base+'/signin');await page.click('button');await response;
   return {context,close:async()=>browser.close()};
 }});
 const candidate=createTiebaLoginIntegration({createSession,verifyIdentity:async ctx=>{const r=await ctx.request.get(base+'/identity');return {state:r.status()===200 && await r.text()==='fixture-online'?'online':'unknown'};},listSource:{list:async()=>[{url}]},transportOptions:{resolve4:async()=>['8.8.8.8'],resolve6:async()=>[],request:async ({signal})=>{const r=await context.request.get(base+'/p/123',{signal});return {status:r.status(),body:await r.body()};}},executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome'});
 const room=startVirtualRoomServer({port:0,host:'127.0.0.1',dataDir:dir,tiebaLoginProvider:candidate.provider});
 t.after(async()=>{await room.stop();await candidate.close();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})});
 const address=await room.ready, roomBase=`http://127.0.0.1:${address.port}`;
 assert.match(await (await fetch(roomBase+'/login')).text(),/tieba-start/);
 const reader=createTiebaReader({enabled:true,source:candidate.source,dir,brain:{complete:async({prompt})=>{assert.doesNotMatch(prompt,/fixture-secret/);return JSON.stringify({action:'continue',record:false,keywords:[]});}}});
 assert.equal((await reader.run()).status,'source_failed');
 assert.deepEqual(await (await fetch(roomBase+'/api/account/tieba/start',{method:'POST',headers:{origin:roomBase}})).json(),{state:'online'});
 assert.deepEqual(await reader.run(),{status:'completed',read:1,saved:0});assert.equal(threadHits,1);
 valid=false;assert.deepEqual(await (await fetch(roomBase+'/api/account/tieba/status')).json(),{state:'unknown'});
 assert.equal((await reader.run()).status,'source_failed');assert.equal(threadHits,1);
});
