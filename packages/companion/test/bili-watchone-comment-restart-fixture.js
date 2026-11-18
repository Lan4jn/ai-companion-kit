import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';
const [home,port,account,aid,bvid,mode,video]=process.argv.slice(2);
process.env.HOME=home;
if(mode==='ledgerfail') process.env.BILI_COMMENT_LEDGER_DIR=path.join(home,'not-a-directory','ledger');
const originalLaunch=chromium.launch.bind(chromium);
chromium.launch=async (...args)=>{
 const browser=await originalLaunch(...args), originalContext=browser.newContext.bind(browser);
 browser.newContext=async (...a)=>{ const ctx=await originalContext(...a);
  await ctx.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.hostname==='www.bilibili.com' && u.pathname.startsWith('/video/')){
    console.log('FIXTURE_COMMENT_PAGE_OPEN');
    const html=`<script>window.__INITIAL_STATE__={videoData:{aid:${Number(aid)},bvid:${JSON.stringify(bvid)}}}</script><div id="comment"><div class="brt-editor" contenteditable="true"></div><button onclick="fetch('/submit',{method:'POST',body:document.querySelector('.brt-editor').innerText}).catch(()=>{})">发布</button></div>`;
    return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
   }
   if(u.hostname==='www.bilibili.com' && u.pathname==='/submit'){
    try { await fetch(`http://127.0.0.1:${port}/submit`,{method:'POST',body:JSON.stringify({account,aid,body:route.request().postData()})}); } catch {}
    return route.abort('failed');
   }
   return route.abort('blockedbyclient');
  });
  const newPage=ctx.newPage.bind(ctx);ctx.newPage=async()=>{const page=await newPage();page.waitForTimeout=async()=>{};return page};return ctx;
 };return browser;
};
const {watchVideoPage,closeWatchBrowser}=await import('../src/bili-browser.js');
const {startBiliLiving,stopBiliLiving,__debug}=await import('../src/bili-living.js');
const play=await originalLaunch({executablePath:process.env.CHROME_PATH||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
try {
 const page=await play.newPage();await page.route('**/*',r=>r.abort());await page.setContent('<video muted></video>');
 await page.evaluate(src=>new Promise(resolve=>{const v=document.querySelector('video');v.onloadedmetadata=resolve;v.src=src}),`data:video/webm;base64,${fs.readFileSync(video).toString('base64')}`);
 const draft=mode==='long'?'这只小猫看着窗外的样子'.repeat(6):mode==='privacy'?'我的电话是13800138000请记住':'小猫盯着窗外的样子让我想笑';
 const brain={complete:async({prompt})=>prompt.includes('播放中已观察到')?'{"decision":"continue"}':'{"interest":"neutral","like":false,"comment":true,"danmaku":false}',reply:async({key})=>({text:key==='__bili_comment__'?JSON.stringify({want:true,text:draft}):'null'})};
 startBiliLiving({brain,memory:{},credentials:{dedeuserid:account,sessdata:'synthetic',bili_jct:'synthetic'},initialDelayMs:3600000,watchBrowserRate:1,commentEnabled:true,ownerIds:['13800138000']});
 const result=await __debug.watchOne({bvid,cid:1,aid:Number(aid),title:'合成猫视频',up:'合成',duration:3},{fetchDanmaku:async()=>[],fetchSubtitle:async()=>[],fetchHotComments:async()=>[],understand:async()=>({complete:true,duration:3,segments:[{start:0,end:3,visual:'小猫望向窗外',subtitle:''}]}),browserWatch:async(_id,_cred,opts)=>{const r=await watchVideoPage(page,opts);return {...r,ok:r.watched>0}}});
 console.log('FIXTURE_RESULT '+JSON.stringify({full:result.playback?.fullWatchVerified,played:result.played,mode,account,aid}));
 if(!result.playback?.fullWatchVerified)process.exitCode=1;
} finally {stopBiliLiving();await closeWatchBrowser();await play.close()}
