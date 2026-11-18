import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as bili from '../src/bili-browser.js';

const chrome = process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
test('real ended event is captured before same-element autoplay resets playback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-playback-'));
  let browser;
  try {
    const file = join(dir, 'video.webm');
    execFileSync('ffmpeg', ['-loglevel','error','-f','lavfi','-i','color=c=black:s=32x32:r=10:d=2','-c:v','libvpx','-an',file]);
    const data = `data:video/webm;base64,${readFileSync(file).toString('base64')}`;
    browser = await chromium.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    await page.setContent('<video muted></video>');
    await page.evaluate(async src => { const v = document.querySelector('video'); v.src=src; await new Promise(resolve=>v.addEventListener('loadedmetadata',resolve,{once:true})); v.addEventListener('ended',()=>{v.currentTime=0; v.play();}); },data);
    assert.equal(typeof bili.watchVideoPage, 'function', 'page playback must expose a testable real-browser path');
    const result = await bili.watchVideoPage(page, {seconds:3,rate:1});
    assert.equal(result.playback.complete,true,JSON.stringify(result));
    assert.ok(result.watched > 1.8,JSON.stringify(result));
    assert.ok(result.playback.end >= 1.85,JSON.stringify(result));
    for (const scenario of ['seek','early-seek','fake-ended','source-change','resume','pause']) {
      const p = await browser.newPage();
      await p.setContent('<video muted></video>');
      await p.evaluate(async ({src, scenario}) => {
        const v = document.querySelector('video'); v.src=src;
        await new Promise(resolve=>v.addEventListener('loadedmetadata',resolve,{once:true}));
        if (scenario === 'resume') {
          v.currentTime=1;
          await new Promise(resolve=>v.addEventListener('seeked',resolve,{once:true}));
          window.rewindEvidence = [];
          v.addEventListener('seeked', event => window.rewindEvidence.push({trusted:event.isTrusted,time:v.currentTime,paused:v.paused}));
        }
        if (scenario === 'early-seek') {
          window.earlySeekEvents = 0;
          v.addEventListener('seeking',()=>window.earlySeekEvents++);
          v.addEventListener('play',()=>{v.currentTime=0.246;},{once:true});
        }
        v.addEventListener('playing',()=>setTimeout(()=>{
          if (scenario === 'seek') v.currentTime=1.7;
          if (scenario === 'fake-ended') v.dispatchEvent(new Event('ended'));
          if (scenario === 'source-change') v.src=src+'#different';
          if (scenario === 'pause') v.pause();
        },300),{once:true});
      },{src:data,scenario});
      const r = await bili.watchVideoPage(p,{seconds:scenario === 'fake-ended' ? 0.8 : 3,rate:1});
      assert.equal(r.playback.complete, scenario === 'resume', `${scenario}: ${JSON.stringify(r)}`);
      if (scenario === 'resume') {
        const rewinds = await p.evaluate(() => window.rewindEvidence);
        assert.ok(rewinds.some(e => e.trusted && e.paused && Math.abs(e.time) < 0.001), `resume must really rewind while paused: ${JSON.stringify(rewinds)}`);
        assert.ok(r.playback.start <= 0.05 && r.watched > 1.8, `resume must watch from start: ${JSON.stringify(r)}`);
      }
      if (scenario === 'early-seek') assert.ok(await p.evaluate(()=>window.earlySeekEvents > 0), 'startup seek must actually occur');
      await p.close();
    }
  } finally { await browser?.close(); rmSync(dir,{recursive:true,force:true}); }
});
