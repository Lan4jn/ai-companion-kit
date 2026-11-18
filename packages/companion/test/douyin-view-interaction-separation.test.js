import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { startDouyinLiving, stopDouyinLiving, browseDouyinLive, watchAndInteractDouyinVideo } from '../src/douyin-living.js';

// Execute only in a network-isolated environment with a synthetic HOME and memory.
test('offline real browser: viewing and autonomous decisions remain separate', { timeout: 240000, skip: process.env.DOUYIN_OFFLINE_SANDBOX !== '1' && 'requires isolated network namespace and synthetic HOME' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'douyin-separation-'));
  const media = join(dir, 'video.mp4');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=80x60:rate=10:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-an','-y',media]);
  const video = readFileSync(media).toString('base64');
  let clicks = [], decisions = [], waits = [], response = {like:false,follow:false}, transition = false;
  const html = () => `<!doctype html><div data-e2e="detail-video-info">合成测试视频内容</div><div data-e2e="user-info"><div>测试作者</div><button onclick="console.log('clicked-follow');${transition ? "this.textContent='已关注'" : ''}">关注</button></div><button data-e2e="video-player-digg" aria-pressed="false" onclick="console.log('clicked-like');${transition ? "this.setAttribute('aria-pressed','true')" : ''}">赞</button><video muted></video><script>const b=Uint8Array.from(atob('${video}'), c=>c.charCodeAt(0)); const src=URL.createObjectURL(new Blob([b],{type:'video/mp4'})); document.querySelector('video').src=src; window._ROUTER_DATA={aweme_id:'123',video:{src}};</script>`;
  const feed = '<div data-aweme-id="123">这是一条合成测试视频内容<br>@测试作者</div>';
  const originalLaunch = chromium.launch, lookup = dns.lookup, request = https.request;
  // Production selection is deterministic here: the synthetic feed has one item,
  // while the configured interaction probabilities are exactly zero or one.
  dns.lookup = async () => [{address:'8.8.8.8',family:4}];
  https.request = (url, options, callback) => {
    assert.equal(url.href, 'https://www.douyin.com/video/123');
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode=200; res.headers={'content-type':'text/html; charset=utf-8'}; callback(res); res.emit('data',Buffer.from(html())); res.emit('end'); });
    return req;
  };
  chromium.launch = async (...args) => {
    args[0].args.push('--host-resolver-rules=MAP * 0.0.0.0', '--no-proxy-server', '--disable-background-networking');
    const browser = await originalLaunch.apply(chromium,args);
    const createContext = browser.newContext.bind(browser);
    browser.newContext = async opts => {
      const ctx = await createContext(opts);
      ctx.on('page', page => {
        // Only explicit UI-settling sleeps are virtualized; Chromium media,
        // playback continuity, DOM actions and their deadlines remain real.
        page.waitForTimeout = async ms => { waits.push(ms); };
        page.on('console', msg => { if (msg.text().startsWith('clicked-')) clicks.push(msg.text()); });
      });
      if (opts?.serviceWorkers !== 'block') await ctx.route('**/*', route => route.fulfill({status:200,contentType:'text/html',body:feed}));
      return ctx;
    };
    return browser;
  };
  const brain = { describeVideo: async () => '合成测试画面', complete: async input => { decisions.push(input); return JSON.stringify(response); } };
  const start = enabled => { startDouyinLiving({enabled, brain, memory:{dir}, opts:{likeChance:1,followChance:1,commentChance:0}, ownerIds:['12345']}); };
  try {
    start(false);
    assert.equal((await browseDouyinLive({isOwner:true,targetUrl:'https://www.douyin.com/video/123'})).success,false);
    assert.equal((await watchAndInteractDouyinVideo('https://www.douyin.com/video/123',{doLike:true,doFollow:true})).success,false);
    assert.deepEqual(clicks,[]);
    start(true);
    for (const isOwner of [false,true]) {
      const result=await browseDouyinLive({isOwner,targetUrl:'https://www.douyin.com/video/123'});
      assert.equal(result.success,true,JSON.stringify(result));
      assert.equal(result.liked,false); assert.equal(result.followed,false);
      assert.equal(result.likeStatus,'skipped'); assert.equal(result.followStatus,'skipped');
      assert.deepEqual(clicks,[]); assert.equal(decisions.length,0);
    }
    const requested=await browseDouyinLive({isOwner:false});
    assert.equal(requested.success,true,JSON.stringify(requested));
    assert.equal(requested.liked,false); assert.equal(requested.followed,false);
    assert.deepEqual(clicks,[]); assert.equal(decisions.length,0);
    const no = await browseDouyinLive({isOwner:false,autonomous:true});
    assert.equal(no.success,true,JSON.stringify(no)); assert.equal(decisions.length,1);
    assert.equal(no.liked,false); assert.equal(no.followed,false); assert.deepEqual(clicks,[]);
    response={like:true,follow:true};
    const unconfirmed=await browseDouyinLive({isOwner:false,autonomous:true});
    assert.equal(unconfirmed.success,true,JSON.stringify(unconfirmed));
    assert.equal(unconfirmed.likeStatus,'unconfirmed'); assert.equal(unconfirmed.followStatus,'unconfirmed');
    assert.equal(unconfirmed.liked,false); assert.equal(unconfirmed.followed,false);
    assert.deepEqual(clicks,['clicked-like','clicked-follow']);
    clicks=[]; transition=true;
    const yes=await browseDouyinLive({isOwner:false,autonomous:true});
    assert.equal(yes.success,true,JSON.stringify(yes)); assert.equal(yes.likeStatus,'confirmed'); assert.equal(yes.followStatus,'confirmed');
    assert.equal(yes.liked,true); assert.equal(yes.followed,true); assert.deepEqual(clicks,['clicked-like','clicked-follow']);
    assert.ok(waits.includes(3000) && waits.includes(2500) && waits.includes(800), `expected UI waits: ${waits}`);
  } finally { await stopDouyinLiving(); chromium.launch=originalLaunch; dns.lookup=lookup; https.request=request; rmSync(dir,{recursive:true,force:true}); }
});
