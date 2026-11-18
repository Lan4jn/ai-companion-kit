import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchVideoPage } from '../src/bili-browser.js';
import { __debug } from '../src/bili-living.js';

test('model sees only fully observed segments and can choose to leave', async () => {
  const prompts=[];
  const brain={complete:async ({prompt})=>{prompts.push(prompt); return '{"decision":"skip"}';}};
  const coverage={segments:[{start:0,end:1,visual:'已播放画面'},{start:1,end:3,visual:'未来画面'}]};
  const result=await __debug.decideMidWatch({brain,coverage,progress:{start:0,end:1.5,duration:5}});
  assert.equal(result,'skip'); assert.match(prompts[0],/已播放画面/); assert.doesNotMatch(prompts[0],/未来画面/);
});

test('unavailable decisions and unobserved content do not manufacture a skip', async () => {
  let calls=0; const brain={complete:async()=>{calls++; return 'not json';}};
  const coverage={segments:[{start:0,end:2,visual:'画面'}]};
  assert.equal(await __debug.decideMidWatch({brain,coverage,progress:{start:0,end:1,duration:5}}),'continue');
  assert.equal(calls,0);
  assert.equal(await __debug.decideMidWatch({brain,coverage,progress:{start:0,end:2,duration:5}}),'continue');
});

test('synthetic player can stop early on an observed model decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-midwatch-')); let browser;
  try {
    const file = join(dir, 'sample.webm');
    execFileSync('ffmpeg', ['-loglevel','error','-f','lavfi','-i','color=black:s=32x32:r=10:d=5','-c:v','libvpx','-an',file]);
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage(); await page.setContent('<video muted></video>');
    await page.evaluate(src => new Promise(resolve => { const v=document.querySelector('video'); v.onloadedmetadata=resolve; v.src=src; }), `data:video/webm;base64,${readFileSync(file).toString('base64')}`);
    let calls=0;
    const result=await watchVideoPage(page,{seconds:7,rate:1,expectedDuration:5,onProgress:async p=>{calls++; assert.ok(p.end>0); return 'skip';}});
    assert.ok(calls>0); assert.equal(result.skipped,true); assert.equal(result.playback.complete,false); assert.ok(result.watched>0 && result.watched<5);
  } finally { await browser?.close(); rmSync(dir,{recursive:true,force:true}); }
});
