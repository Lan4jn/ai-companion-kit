import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { perceiveDouyinFullPage } from '../src/douyin-full-video.js';

test('delayed observation replays from beginning and independently verifies playback and processing', {timeout:30000}, async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'dy-replay-')); let server,browser;
  try {
    const file=join(dir,'fixture.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=4','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',file]);
    const bytes=readFileSync(file);
    server=http.createServer((req,res)=>{if(req.url==='/fixture.mp4'){res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);}else{res.writeHead(200,{'content-type':'text/html'});res.end('<script>window._ROUTER_DATA={aweme_id:"123",video:{url_list:[location.origin+"/fixture.mp4"]}}</script><video muted autoplay src="/fixture.mp4"></video>');}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true,executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',args:['--no-sandbox']});
    const page=await browser.newPage(); const url=`http://127.0.0.1:${server.address().port}/video/123`; await page.goto(url);
    await page.waitForFunction(()=>document.querySelector('video').currentTime>2);
    const result=await perceiveDouyinFullPage(page,{describeVideo:async()=> '合成画面'},{expectedWorkUrl:url,restartFromBeginning:true});
    assert.equal(result.complete,true); assert.equal(result.playback.complete,true); assert.ok(result.playback.start < 0.5); assert.equal(result.success,true);
  } finally {if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
