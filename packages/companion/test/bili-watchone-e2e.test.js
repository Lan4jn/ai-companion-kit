import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright-core';
import {watchVideoPage} from '../src/bili-browser.js';
import {startBiliLiving,stopBiliLiving,__debug} from '../src/bili-living.js';
import {Memory} from '../src/memory.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {createBiliBackgroundFilter} from '../src/bili-background-memory.js';
import {Brain} from '../src/brain.js';
import {OneBot} from '../src/transport-onebot.js';
import {handleTurn} from '../src/index.js';
import {register} from 'node:module';
register('./memory-brain-fake-ws-loader.js', import.meta.url);
async function ownerEvent(){
 let done; const received=new Promise(r=>done=r); const bot=new OneBot({wsUrl:'ws://fixture',onMessage:done}); bot.api=async()=>({ok:false});
 try { for(let i=0;!bot.ws && i<1000;i++) await new Promise(r=>setTimeout(r,1)); assert.ok(bot.ws); bot.ws.emit('open'); bot.ws.emit('message',JSON.stringify({post_type:'message',message_type:'private',user_id:1,message_id:123,message:[{type:'text',data:{text:'你最近在B站有啥好看的？'}}]})); return await received; } finally {bot.close();}
}

const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
const bvid='BV1234567890';
const segments=[{start:0,end:0.5,visual:'小猫趴窗边'},{start:0.5,end:5,visual:'未来片段'}];

for (const forgetKind of ['fragment','video','no-interest']) test(`watchOne playback to chat and ${forgetKind} tombstone`,async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'entry-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 t.mock.method(globalThis,'fetch',async()=>{throw Error('synthetic test: network blocked')});
 initializeManagedStore(path.join(dir,'memory-brain-scoped'));
 const config={dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,backend:'sqlite-fts',trustedProcess:true,trustedScope:scope,authorizedSources:['bili-observation']}};
 const filter=createBiliBackgroundFilter(config,dir); const memory=new Memory({dir});
 const video=path.join(dir,'sample.webm'); execFileSync('ffmpeg',['-loglevel','error','-f','lavfi','-i','color=black:s=32x32:r=10:d=5','-c:v','libvpx','-an',video]);
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']}); t.after(()=>browser.close());
 const page=await browser.newPage(); await page.route('**/*',route=>route.abort()); await page.setContent('<video muted></video>');
 await page.evaluate(src=>new Promise(resolve=>{const v=document.querySelector('video');v.onloadedmetadata=resolve;v.src=src}),`data:video/webm;base64,${fs.readFileSync(video).toString('base64')}`);
 const prompts=[]; const brain={complete:async({prompt})=>{prompts.push(prompt); if(prompt.includes('播放中已观察到')) return '{"decision":"skip"}'; if(prompt.includes('以下仅为已播放')) return forgetKind==='no-interest'?'{"interest":"unknown"}':JSON.stringify({interest:'like',start:0,end:0.5,quote:'小猫',thought:'我喜欢小猫'}); throw Error('unexpected model call');}};
 startBiliLiving({brain,memory,biliBackgroundFilter:filter,biliFragmentScope:scope,initialDelayMs:3600000,watchBrowserRate:1}); t.after(()=>stopBiliLiving());
 const result=await __debug.watchOne({bvid,cid:1,aid:1,title:'合成视频',up:'合成',duration:5},{fetchDanmaku:async()=>[],fetchSubtitle:async()=>[],fetchHotComments:async()=>[],understand:async()=>({complete:true,duration:5,segments}),browserWatch:async (_id,_cred,opts)=>{const r=await watchVideoPage(page,opts);return {...r,ok:r.watched>0}}});
 assert.equal(result.skipped,true); assert.equal(result.playback.fullWatchVerified,false);
 assert.equal(prompts.filter(p=>p.includes('播放中已观察到')).length,1);
 assert.doesNotMatch(prompts.find(p=>p.includes('播放中已观察到')),/未来片段/);
 const reloaded=new Memory({dir}); const rows=reloaded.biliFeelingCandidates(bvid);
 if(forgetKind==='no-interest'){assert.equal(rows.length,0); assert.equal(prompts.filter(p=>p.includes('以下仅为已播放')).length,1); return;}
 assert.equal(rows.length,1); assert.equal((await filter(rows)).length,1);
 const restart=(expected)=>execFileSync(process.execPath,[path.resolve('test/bili-watchone-restart-fixture.js'),dir,expected],{cwd:process.cwd(),env:{...process.env,HOME:dir},stdio:'pipe',timeout:30000});
 restart('yes');
 let messages=[]; t.mock.method(globalThis,'fetch',async (_url,opts)=>{messages=JSON.parse(opts.body).messages;return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'好'}}]})}});
 const chat=new Brain({apiKey:'synthetic',baseUrl:'https://model.invalid/v1',memory:reloaded,dataDir:dir,ownerIds:['1']}); const event=await ownerEvent();
 async function recall(){messages=[];await handleTurn({brain:chat,memory:reloaded,bot:{},human:{say:async()=>({ok:true})},waker:{}},[event],config);return JSON.stringify(messages)}
 async function background(){let prompt='';await __debug.decideBiliBrowsing({complete:async p=>{prompt=p.prompt;return '{"want":false}'}},reloaded,{todayCount:0},new AbortController().signal,filter);return prompt}
 assert.match(await recall(),/我喜欢小猫/); assert.match(await background(),/我喜欢小猫/);
 const forged=structuredClone(rows[0]); forged.biliFeeling.credential.payload.segment.visual='伪造'; assert.deepEqual(await filter([forged]),[]);
 const other=createBiliBackgroundFilter({...config,ownerIds:['2'],memoryBrain:{...config.memoryBrain,trustedScope:{...scope,user:'2',session:'private:2'}}},dir); assert.deepEqual(await other(rows),[]);
 const store=createManagedMemoryBrain({directory:path.join(dir,'memory-brain-scoped'),scope,sources:['bili-observation'],trustedProcess:true,backend:'sqlite-fts'});
 await store.forget(scope,{source:'bili-observation',evidence:forgetKind==='fragment'?rows[0].biliFeeling.sourceId:`https://www.bilibili.com/video/${bvid}`}); assert.deepEqual(await filter(rows),[]);
 assert.doesNotMatch(await recall(),/我喜欢小猫/); assert.doesNotMatch(await background(),/我喜欢小猫/);
 restart('no');
});
