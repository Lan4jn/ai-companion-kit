import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {watchVideoPage} from '../src/bili-browser.js';
import {openFragmentVault} from '../src/bili-fragment-vault.js';
import {initializeManagedStore,createManagedMemoryBrain} from '../src/memory-brain-trust.js';
import {createBiliBackgroundFilter} from '../src/bili-background-memory.js';
import {__debug} from '../src/bili-living.js';
import {Memory} from '../src/memory.js';

test('real synthetic playback issues a content-bound credential only after an early skip',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bili-auth-live-')); let browser;
 try {
  const file=join(dir,'v.webm'); execFileSync('ffmpeg',['-loglevel','error','-f','lavfi','-i','color=black:s=32x32:r=10:d=5','-c:v','libvpx','-an',file]);
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage(); await page.setContent('<video muted></video>');
  await page.evaluate(src=>new Promise(resolve=>{const v=document.querySelector('video');v.onloadedmetadata=resolve;v.src=src;}),`data:video/webm;base64,${readFileSync(file).toString('base64')}`);
  const scope={tenant:'companion',platform:'qq',type:'private',user:'1',session:'private:1'};
  const result=await watchVideoPage(page,{seconds:7,rate:1,expectedDuration:5,onProgress:async()=> 'skip',fragment:{dir,scope,bvid:'BV1234567890',segments:[{start:0,end:0.5,visual:'小猫趴窗边'}]}});
  assert.equal(result.skipped,true); assert.equal(result.fragments?.length,1);
  const {token,payload}=result.fragments[0]; const vault=openFragmentVault(join(dir,'bili-fragment-vault'));
  assert.equal(vault.verify(token,payload),true); assert.equal(vault.verify(token,{...payload,bvid:'BV1234567891'}),false);
  initializeManagedStore(join(dir,'memory-brain-scoped'));
  const filter=createBiliBackgroundFilter({dataDir:dir,ownerIds:['1'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:scope,authorizedSources:['bili-observation']}},dir);
  const memory=new Memory({dir});
  const brain={complete:async()=>JSON.stringify({interest:'like',start:0,end:0.5,quote:'小猫',thought:'我喜欢小猫'})};
  const record=await __debug.rememberSkippedFeeling({brain,memory,bvid:payload.bvid,duration:5,coverage:{duration:5,segments:[payload.segment]},browserResult:{...result,ok:true},filter});
  assert.ok(record,'selected authenticated fragment must be written');
  const rows=new Memory({dir}).biliFeelingCandidates('BV1234567890');
  assert.equal(rows.length,1); assert.equal((await filter(rows)).length,1);
  const altered=structuredClone(rows[0]); altered.biliFeeling.credential.payload.segment.visual='小狗';
  assert.deepEqual(await filter([altered]),[]);
  const otherScope={...scope,user:'2',session:'private:2'};
  const otherFilter=createBiliBackgroundFilter({dataDir:dir,ownerIds:['2'],memoryBrain:{enabled:true,trustedProcess:true,trustedScope:otherScope,authorizedSources:['bili-observation']}},dir);
  assert.deepEqual(await otherFilter(rows),[]);
  const store=createManagedMemoryBrain({directory:join(dir,'memory-brain-scoped'),scope,sources:['bili-observation'],trustedProcess:true});
  await store.forget(scope,{source:'bili-observation',evidence:record.biliFeeling.sourceId});
  assert.deepEqual(await filter(rows),[]);
  await store.forget(scope,{source:'bili-observation',evidence:`https://www.bilibili.com/video/${payload.bvid}`});
  assert.deepEqual(await filter(rows),[]);
 } finally {await browser?.close();rmSync(dir,{recursive:true,force:true});}
});
