import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {chromium} from 'playwright-core';

test('handoff viewer permits retry after a failed start and pre-start input is safe', async () => {
 const html=fs.readFileSync(new URL('../src/douyin-handoff-viewer.html',import.meta.url));
 let starts=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/handoff/start'){starts++;res.writeHead(409,{'Content-Type':'application/json'});return res.end('{}');}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 try {
  browser=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===`http://127.0.0.1:${server.address().port}`?route.continue():route.abort());
  const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/handoff`);
  await page.locator('#keyboard-input').focus();await page.keyboard.press('Enter');await page.keyboard.type('abc');await page.locator('canvas').click();
  await page.locator('#start').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent==='无法启动接管');
  assert.equal(await page.locator('#start').isEnabled(),true);
  await page.locator('#start').click();await page.waitForTimeout(100);assert.equal(starts,2);
  assert.deepEqual(errors,[]);
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
});
