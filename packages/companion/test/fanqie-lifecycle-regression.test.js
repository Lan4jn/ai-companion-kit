import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createGoalCore} from '../src/goal-core.js';
import {createFanqieIntegration} from '../src/fanqie-integration.js';
import {initDesireEngine,renderDesirePrompt} from '../src/desire-engine.js';

test('failed reading closes its desire and the next attempt reuses the existing book goal', async t=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-life-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'fanqie-goals.json')});
 const opts={serial:'test',brain:{complete:async()=>'{"want":true,"bookTitle":"测试书","goal":"read_page"}'},memoryDir:dir,want:async()=>true,goalCore:core,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>null};
 const app=createFanqieIntegration(opts);
 assert.equal((await app.run()).ok,false);
 let state=core.snapshot(); assert.equal(Object.values(state.desires)[0].status,'failed');
 assert.equal((await app.run()).ok,false);
 state=core.snapshot(); assert.equal(Object.keys(state.goals).length,1); assert.equal(Object.keys(state.desires).length,2);
 initDesireEngine(dir); assert.match(renderDesirePrompt('idle'),/测试书/); assert.match(renderDesirePrompt('idle'),/失败/);
});

test('a failed attempt can later complete the same goal with verified observed text', async t=>{
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-recover-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'fanqie-goals.json')});
 let available=false;
 const text='测试正文内容'.repeat(20);
 const {createHash}=await import('node:crypto');
 const app=createFanqieIntegration({serial:'test',brain:{complete:async req=>req.system.includes('阅读目标')?'{"want":true,"bookTitle":"测试书","goal":"read_page"}':'{"interested":true,"continueReading":false,"summary":"测试","keywords":[]}'},memoryDir:dir,want:async()=>true,goalCore:core,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>available?{chapter:'一',page:1,total:3}:null,capture:async()=>({text,source:'番茄小说屏幕OCR（可能存在识别错误）',fingerprint:createHash('sha256').update(text).digest('hex')})});
 assert.equal((await app.run()).ok,false); available=true; assert.equal((await app.run()).ok,true);
 const state=core.snapshot(); assert.equal(Object.keys(state.goals).length,1); assert.equal(Object.values(state.goals)[0].status,'completed'); assert.deepEqual(Object.values(state.desires).map(d=>d.status),['failed','completed']);
});
