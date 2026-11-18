import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const home=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-negative-'));
process.env.HOME=home;
const {chromium}=await import('playwright-core');
const {watchVideoPage}=await import('../src/bili-browser.js');
const {Memory}=await import('../src/memory.js');
const {startBiliLiving,stopBiliLiving,__debug}=await import('../src/bili-living.js');
const file=path.join(home,'video.webm');
execFileSync('ffmpeg',['-loglevel','error','-f','lavfi','-i','color=black:s=32x32:r=10:d=5','-c:v','libvpx','-an',file]);
const src=`data:video/webm;base64,${fs.readFileSync(file).toString('base64')}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
test.after(async()=>{stopBiliLiving();await browser.close();fs.rmSync(home,{recursive:true,force:true});});
const segments=[{start:0,end:0.5,visual:'小猫趴窗边'},{start:0.5,end:5,visual:'未来片段'}];
const deps={fetchDanmaku:async()=>[],fetchSubtitle:async()=>[],fetchHotComments:async()=>[],understand:async()=>({complete:true,duration:5,segments})};
const target={bvid:'BV1234567890',cid:1,aid:123456,title:'合成视频',up:'合成',duration:5};
for (const scenario of ['no-play','pause','ad','partial','unknown-like']) test(`watchOne ${scenario} stays network isolated`,async t=>{
 const ctx=await browser.newContext();await ctx.route('**/*',route=>route.abort());t.after(()=>ctx.close());
 const page=await ctx.newPage();await page.setContent('<video muted></video>');
 await page.evaluate(src=>new Promise(resolve=>{const v=document.querySelector('video');v.onloadedmetadata=resolve;v.src=src}),src);
 if(scenario==='no-play') await page.evaluate(()=>{document.querySelector('video').play=()=>Promise.reject(Error('blocked'));});
 if(scenario==='pause'||scenario==='ad') await page.evaluate(mode=>{const v=document.querySelector('video');v.addEventListener('playing',()=>setTimeout(()=>{if(mode==='pause')v.pause();else {const ad=document.createElement('div');ad.className='bpx-player-ad';document.body.append(ad);}},350),{once:true});},scenario);
 const calls=[]; const oldFetch=globalThis.fetch;globalThis.fetch=async (url,opts={})=>{calls.push({url:String(url),method:opts.method||'GET'});if(scenario==='unknown-like'&&String(url).includes('/has/like')) return {json:async()=>({code:0,data:0})};if(scenario==='unknown-like'&&String(url).endsWith('/archive/like'))throw Error('synthetic unknown outcome');throw Error('network blocked');};t.after(()=>{globalThis.fetch=oldFetch;});
 const prompts=[];const brain={complete:async({prompt})=>{prompts.push(prompt);if(prompt.includes('播放中已观察到'))return '{"decision":"continue"}';if(prompt.includes('经播放验证'))return '{"interest":"like","like":true,"comment":false,"danmaku":false}';return '{}';}};
 const dir=path.join(home,scenario);fs.mkdirSync(dir);const memory=new Memory({dir});
 startBiliLiving({brain,memory,credentials:{bili_jct:'synthetic',sessdata:'synthetic'},initialDelayMs:3600000,watchBrowserRate:1,watchBrowserSeconds:1,commentEnabled:true});t.after(()=>stopBiliLiving());
 const run=()=>__debug.watchOne({...target},{...deps,browserWatch:async(_id,_cred,opts)=>{const r=await watchVideoPage(page,{...opts,seconds:scenario==='partial'?2:scenario==='pause'||scenario==='ad'?3:opts.seconds});return {...r,ok:r.watched>0};}});
 const result=await run();
 if(scenario==='unknown-like'){
  assert.equal(result.playback.fullWatchVerified,true);
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  await run();assert.equal(calls.filter(c=>c.method==='POST').length,1,'unknown like must not be resent');
 }else{
  assert.equal(result.playback.fullWatchVerified,false);
  assert.equal(calls.length,0,'no like or comment network calls');
  assert.equal(prompts.some(p=>p.includes('经播放验证')),false);
  assert.equal(memory.biliFeelingCandidates(target.bvid).length,0);
  if(scenario==='partial') assert.ok(result.playback.watched>0);
  if(scenario==='pause'||scenario==='ad') assert.equal(result.playback.interrupted,true);
 }
});
