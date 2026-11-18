import test from 'node:test';
import assert from 'node:assert/strict';
import {choosePartialBiliFeeling, validPartialBiliFeeling} from '../src/bili-partial-feeling.js';
const samples=Array.from({length:13},(_,i)=>({time:i/2,wall:i/2,duration:20,rate:1,identity:true,seeking:false,paused:false,ended:false,ad:false}));
test('fragment provenance is derived from the played video and exact selected segment',async()=>{
 const r=await choosePartialBiliFeeling({bvid:'BV1234567890',duration:20,coverage:{duration:20,segments:[{start:0,end:5,visual:'小猫趴窗边'}]},browserResult:{ok:true,skipped:true,watched:6,playback:{samples,interrupted:false}},brain:{complete:async()=>JSON.stringify({interest:'like',start:0,end:5,quote:'小猫',thought:'我喜欢'})}});
 assert.ok(validPartialBiliFeeling(r));
 assert.equal(r.biliFeeling.sourceId,'https://www.bilibili.com/video/BV1234567890#segment=0,5');
 r.biliFeeling.sourceId='https://www.bilibili.com/video/BV1234567890#segment=1,5';
 assert.equal(validPartialBiliFeeling(r),false);
});

import fs from 'node:fs';
import path from 'node:path';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {createBiliBackgroundFilter} from '../src/bili-background-memory.js';
import {chromium} from 'playwright-core';
import {execFileSync} from 'node:child_process';
import {watchVideoPage} from '../src/bili-browser.js';

test('fragment and video tombstones coordinate with diary writes',async t=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'bili-frag-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scope={tenant:'companion',platform:'qq',type:'private',session:'private:1',user:'1'};
 const directory=path.join(dir,'memory-brain-scoped'); initializeManagedStore(directory);
 const store=createManagedMemoryBrain({directory,scope,sources:['bili-observation'],trustedProcess:true});
 const filter=createBiliBackgroundFilter({dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['bili-observation']}},dir);
 const file=path.join(dir,'video.webm');
 execFileSync('ffmpeg',['-loglevel','error','-f','lavfi','-i','color=black:s=32x32:r=10:d=5','-c:v','libvpx','-an',file]);
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 t.after(()=>browser.close());
 const page=await browser.newPage(); await page.setContent('<video muted></video>');
 await page.evaluate(src=>new Promise(resolve=>{const v=document.querySelector('video');v.onloadedmetadata=resolve;v.src=src;}),`data:video/webm;base64,${fs.readFileSync(file).toString('base64')}`);
 const segments=[{start:0,end:0.5,visual:'小猫趴窗边'},{start:0.5,end:1,visual:'小猫趴窗边'}];
 const playback=await watchVideoPage(page,{seconds:7,rate:1,expectedDuration:5,onProgress:async p=>p.end>=1.2?'skip':'continue',fragment:{dir,scope,bvid:'BV1234567890',segments}});
 assert.equal(playback.skipped,true); assert.equal(playback.fragments?.length,2);
 const make=async(start,end)=>choosePartialBiliFeeling({bvid:'BV1234567890',duration:5,coverage:{duration:5,segments},browserResult:{...playback,ok:true},brain:{complete:async()=>JSON.stringify({interest:'like',start,end,quote:'小猫',thought:'我喜欢'})}});
 const a=await make(0,0.5), b=await make(0.5,1);
 assert.equal((await filter([a,b])).length,2);
 await store.forget(scope,{source:'bili-observation',evidence:a.biliFeeling.sourceId});
 assert.deepEqual(await filter([a,b]),[b]);
 let entered; const ready=new Promise(r=>entered=r); let release; const gate=new Promise(r=>release=r);
 const write=filter([b],async()=>{entered(); await gate}); await ready;
 let done=false; const forget=store.forget(scope,{source:'bili-observation',evidence:'https://www.bilibili.com/video/BV1234567890'}).then(()=>{done=true});
 await new Promise(r=>setTimeout(r,100)); assert.equal(done,false); release(); await write; await forget;
 let writes=0; assert.deepEqual(await filter([b],async()=>writes++),[]); assert.equal(writes,0);
 assert.deepEqual(await filter([a,b]),[]);
});
