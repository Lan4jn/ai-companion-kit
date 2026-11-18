import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium} from 'playwright-core';

const html=fs.readFileSync(new URL('../src/douyin-handoff-viewer.html',import.meta.url),'utf8');
test('keyboard blur does not discard already queued mobile digits', {timeout:15000}, async()=>{
 const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
 try {
  const page=await browser.newPage();await page.setContent(html);
  const result=await page.evaluate(async()=>{
   const frames=[];ws={readyState:WebSocket.OPEN,send:x=>frames.push([...x])};w=100;
   const el=document.querySelector('#keyboard-input');el.focus();
   for(const ch of '12')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));
   el.blur();await new Promise(r=>setTimeout(r,500));
   return frames.length===4 && frames.every((f,i)=>f[0]===4 && f[1]===(i%2===0?1:0));
  });
  assert.ok(result,'queued digits should survive keyboard blur');
 } finally {await browser.close();}
});

test('remote pointer waits for queued digits', {timeout:15000}, async()=>{
 const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
 try {
  const page=await browser.newPage();await page.setContent(html);
  const result=await page.evaluate(async()=>{
   const frames=[];ws={readyState:WebSocket.OPEN,send:x=>frames.push([...x])};w=100;h=100;
   const el=document.querySelector('#keyboard-input');el.focus();
   for(const ch of '12')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));
   point({clientX:10,clientY:10},1);await new Promise(r=>setTimeout(r,500));
   return frames.map(f=>f[0]).join(',')==='4,4,4,4,5';
  });
  assert.ok(result,'pointer should not overtake digits');
 } finally {await browser.close();}
});

test('Enter waits for pending text before reaching the remote browser', {timeout:15000}, async()=>{
 const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
 try {
  const page=await browser.newPage();await page.setContent(html);
  const result=await page.evaluate(async()=>{
   const frames=[];ws={readyState:WebSocket.OPEN,send:x=>frames.push([...x])};w=100;
   const el=document.querySelector('#keyboard-input');el.focus();
   for(const ch of '12')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));
   el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter'}));
   el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter',code:'Enter'}));
   await new Promise(r=>setTimeout(r,500));
   return frames.map(f=>[f[1],(f[4]<<24)|(f[5]<<16)|(f[6]<<8)|f[7]]);
  });
  assert.deepEqual(result,[[1,49],[0,49],[1,50],[0,50],[1,0xff0d],[0,0xff0d]]);
 } finally {await browser.close();}
});

test('disconnect drops queued input before reconnect', {timeout:15000}, async()=>{
 const browser=await chromium.launch({executablePath:process.env.TEST_CHROMIUM||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking']});
 try {
  const page=await browser.newPage();await page.setContent(html);
  const result=await page.evaluate(async()=>{
   const oldFrames=[],newFrames=[];
   const old={readyState:WebSocket.OPEN,send:x=>oldFrames.push([...x])};ws=old;w=100;wire('fixture');
   const el=document.querySelector('#keyboard-input');el.focus();
   for(const ch of '123')el.dispatchEvent(new InputEvent('input',{bubbles:true,data:ch,inputType:'insertText'}));
   old.onclose();ws={readyState:WebSocket.OPEN,send:x=>newFrames.push([...x])};w=100;
   await new Promise(r=>setTimeout(r,600));return oldFrames.length===0&&newFrames.length===0;
  });
  assert.ok(result,'stale events must not be delivered to a new session');
 } finally {await browser.close();}
});
