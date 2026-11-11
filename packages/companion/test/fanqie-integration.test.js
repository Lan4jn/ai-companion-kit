import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanqieIntegration } from '../src/fanqie-integration.js';
import { createPhoneMutex } from '../src/phone-mutex.js';

test('scheduled reading holds mutex and saves observed OCR before stopping', async () => {
 const events=[]; const mutex=createPhoneMutex();
 const integration=createFanqieIntegration({serial:'test', brain:{complete:async()=>JSON.stringify({interested:true,continueReading:false,summary:'看见的故事',keywords:['故事']})}, memoryDir:'/unused', want:async()=>true, mutex,
  online:async()=>true, navigate:async()=>{events.push('navigate');assert.equal(await mutex.tryBackground(async()=>{}),false);return {ok:true}},
  progress:async()=>({chapter:'第一章',page:1,total:3}), capture:async()=>({text:'正文',source:'OCR',fingerprint:'abc'}), save:async(_dir,r)=>events.push(r), gesture:async()=>{throw Error('unexpected')}
 });
 const result=await integration.scheduler.tick();
 assert.equal(result.ok,true);assert.equal(result.stopped,true);assert.equal(events[0],'navigate');assert.equal(events[1].summary,'看见的故事');assert.equal(events[1].source,'OCR');
});

test('refuses to read when progress changes during OCR', async () => {
 let n=0, understood=0;
 const i=createFanqieIntegration({serial:'test',brain:{complete:async()=>{understood++;return '{}'}},memoryDir:'/unused',want:async()=>true, mutex:createPhoneMutex(),online:async()=>true,navigate:async()=>({ok:true}),progress:async()=>({chapter:'第一章',page:++n,total:3}),capture:async()=>({text:'正文',source:'OCR',fingerprint:'abc'}),save:async()=>{},gesture:async()=>{}});
 const result=await i.run();
 assert.equal(result.ok,false);assert.equal(understood,0);
});

test('does not accept a page turn across an unexpected chapter', async () => {
 let page=1;const text1='春天的花儿在小河旁边慢慢开放微风吹过森林里的鸟儿唱起动听的歌曲';const text2='夜晚的城市灯火通明远处高楼之上有人仰望天空等待漫长的旅途结束';
 const i=createFanqieIntegration({serial:'test',brain:{complete:async()=>JSON.stringify({interested:false,continueReading:true,summary:'正文',keywords:[]})},memoryDir:'/unused',want:async()=>true,mutex:createPhoneMutex(),online:async()=>true,navigate:async()=>({ok:true}),progress:async()=>({chapter:page===1?'第一章':'第二章',page,total:3}),capture:async()=>({text:page===1?text1:text2,source:'OCR',fingerprint:String(page)}),gesture:async()=>{page++},save:async()=>{}});
 const result=await i.run(); assert.equal(result.reason,'chapter-changed'); assert.equal(page,2);
});

test('returns a specific offline error if a device operation fails after the health check', async()=>{
 const i=createFanqieIntegration({serial:'test',brain:{complete:async()=>''},memoryDir:'/unused',want:async()=>true,mutex:createPhoneMutex(),online:async()=>true,navigate:async()=>{throw new Error('error: device offline')}});
 assert.equal((await i.run()).reason,'device-offline');
});

test('verified turn reads the next page and stops at the step limit', async()=>{
 let page=1, gestures=0; const records=[];
 const pages=['春天的花儿在小河旁边慢慢开放微风吹过森林里的鸟儿唱起动听的歌曲','夜晚的城市灯火通明远处高楼之上有人仰望天空等待漫长的旅途结束'];
 const i=createFanqieIntegration({serial:'test',brain:{complete:async()=>JSON.stringify({interested:true,continueReading:true,summary:'正文',keywords:[]})},memoryDir:'/unused',want:async()=>true,maxSteps:2,mutex:createPhoneMutex(),online:async()=>true,navigate:async()=>({ok:true}),progress:async()=>({chapter:'第一章',page,total:4}),capture:async()=>({text:pages[page-1],source:'OCR',fingerprint:String(page)}),gesture:async()=>{page++;gestures++},save:async(_,r)=>records.push(r)});
 const result=await i.run();assert.equal(result.reason,'step-limit');assert.equal(gestures,1);assert.deepEqual(records.map(r=>r.progress.page),[1,2]);
});
