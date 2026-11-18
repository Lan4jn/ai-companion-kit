import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { createTiebaMockHandoff } from '../src/tieba-mock-handoff.js';
import { createTiebaCandidateFactory } from '../src/tieba-login-integration.js';
import { createTiebaReader } from '../src/tieba-reader.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('mock handoff to candidate controlled HTML reader and disconnect', {timeout:60000}, async t => {
 const root=await mkdtemp(join(process.env.TMPDIR,'tieba-joined-'));
 const token='synthetic-only-123456789012345678901234';
 const h=createTiebaMockHandoff({enabled:true,root,accessToken:token,ttlMs:50000,readyMs:20000});
 let hits=0; const server=http.createServer((req,res)=>{if(req.url==='/probe'){hits++;res.setHeader('access-control-allow-origin','*');res.end('ok');return;}if(!h.handle(req,res)){res.writeHead(404);res.end()}});
 server.on('upgrade',(req,socket,head)=>{if(!h.upgrade(req,socket,head))socket.destroy()});
 let browser, candidate;
 t.after(async()=>{await browser?.close();await candidate?.close();await h.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 assert.throws(()=>createTiebaCandidateFactory(),/unavailable/);
 const deps=h.fixtureDependencies(); assert.equal(typeof deps.createTransport,'function'); assert.equal(deps.transportOptions,undefined);
 candidate=createTiebaCandidateFactory({enabled:true,...deps})();
 const reader=createTiebaReader({enabled:true,source:candidate.source,dir:root,brain:{complete:async({prompt})=>{assert.match(prompt,/fixture forum content/);assert.doesNotMatch(prompt,/fixture_session/);return JSON.stringify({action:'continue',record:false,keywords:[]})}}});
 assert.equal((await candidate.provider.status()).state,'unknown');assert.equal((await reader.run()).status,'source_failed');
 browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
 const ctx=await browser.newContext({httpCredentials:{username:'room',password:token},viewport:{width:1024,height:850}});const page=await ctx.newPage();
 await page.goto(base+'/handoff');await page.locator('#start').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='ready',null,{timeout:25000});
 const starting=candidate.provider.start();
 await sleep(1200); assert.deepEqual(await candidate.provider.status(),{state:'unknown'}); await page.locator('canvas').click({position:{x:400,y:400}});
 const started=await starting;
 assert.equal(started.state,'online');
 const probe=await deps.probeReadBoundary(base+'/probe');
 assert.deepEqual(probe, {repeatSignInBlocked:true, localBlocked:true, websocketBlocked:true}); assert.equal(hits,0);
 assert.deepEqual(await candidate.source.list({forum:'肥鱼避难所吧'}),[{url:'https://tieba.baidu.com/p/123'}]); assert.match((await candidate.source.read({forum:'肥鱼避难所吧',url:'https://tieba.baidu.com/p/123'})).body,/fixture forum content/); assert.deepEqual(await reader.run(),{status:'completed',read:1,saved:0});
 await ctx.close();let status;for(let i=0;i<50;i++){status=await candidate.provider.status();if(status.state==='unknown')break;await sleep(100)}
 assert.equal(status.state,'unknown');assert.equal((await reader.run()).status,'source_failed');
});
