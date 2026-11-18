import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanqieIntegration } from '../src/fanqie-integration.js';
import { createPhoneMutex } from '../src/phone-mutex.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function testMutex(t) {
 const dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'fanqie-lock-'));
 t.after(() => rm(dir, {recursive:true, force:true}));
 return createPhoneMutex({lockPath:path.join(dir, 'phone.lock')});
}

test('scheduled reading holds mutex and saves observed OCR before stopping', async (t) => {
 const events=[]; const mutex=await testMutex(t);
 const integration=createFanqieIntegration({serial:'test', brain:{complete:async()=>JSON.stringify({interested:true,continueReading:false,summary:'看见的故事',keywords:['故事']})}, memoryDir:'/unused', want:async()=>true, mutex,
  online:async()=>true, navigate:async()=>{events.push('navigate');assert.equal(await mutex.tryBackground(async()=>{}),false);return {ok:true}},
  progress:async()=>({chapter:'第一章',page:1,total:3}), capture:async()=>({text:'正文',source:'OCR',fingerprint:'abc'}), save:async(_dir,r)=>events.push(r), gesture:async()=>{throw Error('unexpected')}
 });
 const result=await integration.scheduler.tick();
 assert.equal(result.ok,true);assert.equal(result.stopped,true);assert.equal(events[0],'navigate');assert.equal(events[1].summary,'看见的故事');assert.equal(events[1].source,'OCR');
});

test('refuses to read when progress changes during OCR', async (t) => {
 let n=0, understood=0;
 const i=createFanqieIntegration({serial:'test',brain:{complete:async()=>{understood++;return '{}'}},memoryDir:'/unused',want:async()=>true, mutex:await testMutex(t),online:async()=>true,navigate:async()=>({ok:true}),progress:async()=>({chapter:'第一章',page:++n,total:3}),capture:async()=>({text:'正文',source:'OCR',fingerprint:'abc'}),save:async()=>{},gesture:async()=>{}});
 const result=await i.run();
 assert.equal(result.ok,false);assert.equal(result.reason,'reading-unavailable');assert.equal(understood,0);
});

test('does not accept a page turn across an unexpected chapter', async (t) => {
 let page=1;const text1='春天的花儿在小河旁边慢慢开放微风吹过森林里的鸟儿唱起动听的歌曲';const text2='夜晚的城市灯火通明远处高楼之上有人仰望天空等待漫长的旅途结束';
 const i=createFanqieIntegration({serial:'test',brain:{complete:async()=>JSON.stringify({interested:false,continueReading:true,summary:'正文',keywords:[]})},memoryDir:'/unused',want:async()=>true,mutex:await testMutex(t),online:async()=>true,navigate:async()=>({ok:true}),progress:async()=>({chapter:page===1?'第一章':'第二章',page,total:3}),capture:async()=>({text:page===1?text1:text2,source:'OCR',fingerprint:String(page)}),gesture:async()=>{page++},save:async()=>{}});
 const result=await i.run(); assert.equal(result.reason,'chapter-changed'); assert.equal(page,2);
});

test('returns a specific offline error if a device operation fails after the health check', async(t)=>{
 const i=createFanqieIntegration({serial:'test',brain:{complete:async()=>''},memoryDir:'/unused',want:async()=>true,mutex:await testMutex(t),online:async()=>true,navigate:async()=>{throw new Error('error: device offline')}});
 assert.equal((await i.run()).reason,'device-offline');
});

test('verified turn reads the next page and stops at the step limit', async(t)=>{
 let page=1, gestures=0; const records=[];
 const pages=['春天的花儿在小河旁边慢慢开放微风吹过森林里的鸟儿唱起动听的歌曲','夜晚的城市灯火通明远处高楼之上有人仰望天空等待漫长的旅途结束'];
 const i=createFanqieIntegration({serial:'test',brain:{complete:async()=>JSON.stringify({interested:true,continueReading:true,summary:'正文',keywords:[]})},memoryDir:'/unused',want:async()=>true,maxSteps:2,mutex:await testMutex(t),online:async()=>true,navigate:async()=>({ok:true}),progress:async()=>({chapter:'第一章',page,total:4}),capture:async()=>({text:pages[page-1],source:'OCR',fingerprint:String(page)}),gesture:async()=>{page++;gestures++},save:async(_,r)=>records.push(r)});
 const result=await i.run();assert.equal(result.reason,'step-limit');assert.equal(gestures,1);assert.deepEqual(records.map(r=>r.progress.page),[1,2]);
});


test('real reading entry offers observed comments to the autonomous brain without publishing', async(t)=>{
 const events=[]; let n=0;
 const brain={complete:async opts=>{events.push(opts.prompt); if(++n===1)return JSON.stringify({interested:false,continueReading:true,summary:'正文',keywords:[]}); if(n===2)return JSON.stringify({action:'view'}); return JSON.stringify({action:'like',targetId:'invented'});}};
 const reviewReader={openComments:async()=>{events.push('open');return {ok:true}},readComments:async()=>[{text:'真实可见评论'}],submit:async()=>{throw Error('must not publish')}};
 const i=createFanqieIntegration({serial:'test',brain,memoryDir:'/unused',want:async()=>true,mutex:await testMutex(t),online:async()=>true,navigate:async()=>({ok:true}),progress:async()=>({chapter:'第一章',page:1,total:3}),capture:async()=>({text:'正文',source:'OCR',fingerprint:'abc'}),socialGuard:async()=>true,reviewReader,save:async()=>{},gesture:async()=>{throw Error('must not turn from comments')}});
 const result=await i.run();
 assert.equal(result.reason,'social-read-only');
 assert.ok(events.some(x=>typeof x==='string'&&x.includes('真实可见评论')));
 assert.equal(n,3);
});
