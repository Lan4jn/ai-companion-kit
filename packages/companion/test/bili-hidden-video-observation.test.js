import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { watchVideoPage } from '../src/bili-browser.js';

test('hidden video cannot serve as an observed partial fragment', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-hidden-'));
 let browser;
 try {
  const file=path.join(dir,'fixture.webm');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=32x32:r=10:d=8','-c:v','libvpx','-an',file]);
  const src='data:video/webm;base64,'+fs.readFileSync(file).toString('base64');
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-background-networking','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  await page.setContent('<video style="display:none" muted></video>');
  await page.evaluate(async src=>{const v=document.querySelector('video'); v.src=src; await new Promise(resolve=>v.addEventListener('loadedmetadata',resolve,{once:true}));},src);
  const result=await watchVideoPage(page,{seconds:3,rate:1,expectedDuration:8,onProgress:async()=> 'skip'});
  assert.ok(!result.skipped || result.playback.interrupted || !result.watched, JSON.stringify(result));
 } finally {await browser?.close(); fs.rmSync(dir,{recursive:true,force:true});}
});
