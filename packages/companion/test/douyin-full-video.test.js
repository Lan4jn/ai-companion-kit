import test from 'node:test';
import assert from 'node:assert/strict';
import { understandDouyinFile, perceiveDouyinFullPage } from '../src/douyin-full-video.js';
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

test('每段必须真正送模型，失败时不能声称完整', async () => {
  const result = await understandDouyinFile({file: '/missing', duration: 10, brain: {describeVideo: async () => ''}});
  assert.equal(result.complete, false);
  assert.notEqual(result.reason, '');
});

test('合成音视频实切分、逐段调用和播放证据分离', async () => {
  const dir=mkdtempSync(join(process.env.TMPDIR || tmpdir(),'dy-test-'));
  let server, browser;
  try {
    const file=join(dir,'video.mp4');
    execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=4','-f','lavfi','-i','sine=frequency=440:duration=4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-movflags','+faststart','-y',file]);
    const calls=[];
    const brain={describeVideo:async clip => { calls.push(Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',clip],{encoding:'utf8'}))); return '合成测试画面'; }};
    const result=await understandDouyinFile({file,duration:4,brain,segmentSeconds:2,recognize:async wav => {assert.ok(wav.length>100);return '测试音频';}});
    assert.equal(result.complete,true); assert.equal(calls.length,2); assert.equal(result.segments.length,2); assert.equal(result.audio.status,'unreliable');
    const failed=await understandDouyinFile({file,duration:4,segmentSeconds:2,brain:{describeVideo:async () => null}});
    assert.equal(failed.complete,false); assert.equal(failed.reason,'segment_analysis_failed');
    const bytes=readFileSync(file);
    server=http.createServer((req,res) => { if(req.url==='/video.mp4') {res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);} else {res.writeHead(200,{'content-type':'text/html'});res.end('<script>window._ROUTER_DATA={aweme_id:"123",video:{url_list:[location.origin+"/video.mp4"]}}</script><video src="/video.mp4" muted autoplay></video>');} });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true,executablePath:'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',args:['--no-sandbox']});
    const page=await browser.newPage(); const workUrl=`http://127.0.0.1:${server.address().port}/video/123`; await page.goto(workUrl);
    await page.waitForFunction(()=>{const v=document.querySelector('video');return v && !v.paused && v.currentTime>0;});
    const wrongWork=await perceiveDouyinFullPage(page,brain,{expectedWorkUrl:workUrl.replace('/123','/999'),collectHostObservation:true});
    assert.equal(wrongWork.success,false); assert.equal(wrongWork.hostObservation,undefined);
    await page.evaluate(()=>{window._ROUTER_DATA.video.url_list=['https://example.invalid/other.mp4'];});
    const wrongSource=await perceiveDouyinFullPage(page,brain,{expectedWorkUrl:workUrl});
    assert.equal(wrongSource.success,false);
    await page.evaluate(()=>{window._ROUTER_DATA.video.url_list=[location.origin+'/video.mp4'];});
    const observed=await perceiveDouyinFullPage(page,brain,{expectedWorkUrl:workUrl,recognize:async wav => {assert.equal(wav.toString('ascii',0,4),'RIFF');return '页面音轨测试';}, collectHostObservation:true});
    assert.equal(observed.hostObservation?.mediaSource, 'page_reported_refetch');
    assert.equal(observed.hostObservation?.workId, '123');
    assert.equal(observed.hostObservation?.identityBinding, 'untrusted_page_metadata');
    assert.ok(observed.hostObservation?.hostElapsedMs >= 2000);
    assert.ok(observed.hostObservation?.mediaBytes > 0);
    assert.equal(observed.complete,true); assert.equal(observed.playback.complete,true); assert.equal(observed.audio.status,'unreliable'); assert.equal(observed.audio.segments[0].text,'页面音轨测试');
  } finally { if(browser) await browser.close(); if(server) await new Promise(resolve=>server.close(resolve)); rmSync(dir,{recursive:true,force:true}); }
});
