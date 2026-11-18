import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchVideoPage } from '../src/bili-browser.js';

test('trusted playing starts observation even when the play promise is delayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bili-delayed-play-'));
  let browser;
  try {
    const file = join(dir, 'video.webm');
    execFileSync('ffmpeg', ['-loglevel','error','-f','lavfi','-i','color=black:s=32x32:r=10:d=2','-c:v','libvpx','-an',file]);
    const src = `data:video/webm;base64,${readFileSync(file).toString('base64')}`;
    browser = await chromium.launch({executablePath:process.env.CHROME_PATH || '/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
    const page = await browser.newPage();
    await page.setContent('<video muted></video>');
    await page.evaluate(async src => {
      const v = document.querySelector('video');
      v.src = src;
      await new Promise(resolve => v.addEventListener('loadedmetadata', resolve, {once:true}));
      const nativePlay = v.play.bind(v);
      v.play = () => nativePlay().then(() => new Promise(resolve => setTimeout(resolve, 600)));
    }, src);
    const result = await watchVideoPage(page, {seconds:3,rate:1});
    assert.equal(result.playback.complete, true, JSON.stringify(result));
    assert.ok(result.playback.start <= 0.05, JSON.stringify(result));
    assert.ok(result.watched > 1.8, JSON.stringify(result));
  } finally { await browser?.close(); rmSync(dir,{recursive:true,force:true}); }
});
