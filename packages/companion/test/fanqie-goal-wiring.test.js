import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFanqieIntegration } from '../src/fanqie-integration.js';
import { startFanqieAutonomous } from '../src/fanqie-startup.js';
import { saveFanqieMemory } from '../src/fanqie-session.js';
import { createGoalCore } from '../src/goal-core.js';
import { createFanqieGoalSave } from '../src/fanqie-goal.js';

test('real session saves successive pages without advancing a completed desire twice', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-goal-wire-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'goals.json')});
 core.addGoal({id:'g',title:'测试目标',target:3});
 core.addDesire({id:'d',title:'测试阅读',goalId:'g'});
 let page=1;
 const integration=createFanqieIntegration({serial:'test',brain:{complete:async()=>JSON.stringify({interested:true,continueReading:false,summary:'测试摘要',keywords:[]})},memoryDir:dir,want:async()=>true,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>({chapter:'第一章',page,total:3}),capture:async()=>{const text=(page===1?'测试正文甲':'测试正文乙').repeat(20);return {text,source:'番茄小说屏幕OCR（可能存在识别错误）',fingerprint:createHash('sha256').update(text).digest('hex')};},save:createFanqieGoalSave({core,desireId:'d',bookTitle:'测试书',save:saveFanqieMemory})});
 assert.equal((await integration.run()).ok,true);
 page=2;
 assert.equal((await integration.run()).ok,true);
 const state=core.snapshot();
 assert.equal(state.goals.g.progress,1);
 assert.equal(Object.keys(state.events).length,1);
 const rows=(await fs.readFile(path.join(dir,'fanqie-reading.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,2);
 assert.deepEqual(rows.map(x=>x.progress.page),[1,2]);
});

test('absent goal and desire do not interrupt or create goals during a session', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-goal-empty-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'goals.json')});
 const text='测试小说正文'.repeat(20);
 const integration=createFanqieIntegration({serial:'test',brain:{complete:async()=>JSON.stringify({interested:true,continueReading:false,summary:'测试摘要',keywords:[]})},memoryDir:dir,want:async()=>true,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>({chapter:'第一章',page:1,total:3}),capture:async()=>({text,source:'番茄小说屏幕OCR（可能存在识别错误）',fingerprint:createHash('sha256').update(text).digest('hex')}),save:createFanqieGoalSave({core,desireId:'absent',bookTitle:'测试书',save:saveFanqieMemory})});
 assert.equal((await integration.run()).ok,true);
 assert.deepEqual(core.snapshot(),{version:1,goals:{},desires:{},events:{}});
 assert.equal(JSON.parse((await fs.readFile(path.join(dir,'fanqie-reading.jsonl'),'utf8')).trim()).text,text);
});


test('explicit model intention and a verified book page create a persistent reading goal event', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-real-goal-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'goals.json')});
 const text='测试小说正文'.repeat(20);
 const brain={complete:async req=>req.system.includes('阅读目标') ? JSON.stringify({want:true,bookTitle:'测试书',goal:'read_page'}) : JSON.stringify({interested:true,continueReading:false,summary:'读过这一页',keywords:[]})};
 const integration=createFanqieIntegration({serial:'test',brain,memoryDir:dir,want:async()=>true,goalCore:core,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>({chapter:'第一章',page:1,total:3}),capture:async()=>({text,source:'番茄小说屏幕OCR（可能存在识别错误）',fingerprint:createHash('sha256').update(text).digest('hex')})});
 assert.equal((await integration.run()).ok,true);
 const state=createGoalCore({file:path.join(dir,'goals.json')}).snapshot();
 assert.equal(Object.keys(state.events).length,1);
 assert.equal(Object.values(state.goals)[0].status,'completed');
 assert.equal(Object.values(state.desires)[0].status,'completed');
 assert.match(Object.values(state.goals)[0].title,/测试书/);
});


test('a model refusal never creates a reading goal', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-refuse-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'goals.json')}); const text='测试小说正文'.repeat(20);
 const brain={complete:async req=>req.system.includes('阅读目标') ? '{"want":false}' : JSON.stringify({interested:true,continueReading:false,summary:'摘要',keywords:[]})};
 const integration=createFanqieIntegration({serial:'test',brain,memoryDir:dir,want:async()=>true,goalCore:core,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>({chapter:'第一章',page:1,total:3}),capture:async()=>({text,source:'番茄小说屏幕OCR（可能存在识别错误）',fingerprint:createHash('sha256').update(text).digest('hex')})});
 assert.equal((await integration.run()).ok,true);
 assert.equal(Object.keys(core.snapshot().goals).length,0);
});

test('an explicit intention with unavailable reading records a failed attempt without completing its goal', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-no-evidence-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'goals.json')});
 const brain={complete:async()=>JSON.stringify({want:true,bookTitle:'测试书',goal:'read_page'})};
 const integration=createFanqieIntegration({serial:'test',brain,memoryDir:dir,want:async()=>true,goalCore:core,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>null});
 assert.equal((await integration.run()).ok,false);
 const state=core.snapshot(); assert.equal(Object.values(state.events)[0].type,'desire.failed'); assert.equal(Object.values(state.goals)[0].status,'active'); assert.equal(Object.values(state.desires)[0].status,'failed');
});


test('production startup wires willingness and goal events through real integration', async t => {
 const dir=await fs.mkdtemp(path.join(process.env.TMPDIR,'fanqie-start-loop-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const previous=process.env.PHONE_SERIAL; process.env.PHONE_SERIAL='test'; t.after(()=>{if(previous===undefined)delete process.env.PHONE_SERIAL;else process.env.PHONE_SERIAL=previous;});
 const text='测试小说正文'.repeat(20); let integration;
 const brain={complete:async req=>req.system.includes('阅读目标') ? JSON.stringify({want:true,bookTitle:'测试书',goal:'read_page'}) : req.system.includes('是否想读') ? '{"want":true}' : JSON.stringify({interested:true,continueReading:false,summary:'摘要',keywords:[]})};
 const handle=startFanqieAutonomous({enabled:true,serial:'test',brain,dataDir:dir,createIntegration:options=>(integration=createFanqieIntegration({...options,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'测试书'}),progress:async()=>({chapter:'一',page:1,total:3}),capture:async()=>({text,source:'番茄小说屏幕OCR（可能存在识别错误）',fingerprint:createHash('sha256').update(text).digest('hex')})}))});
 t.after(()=>handle.stop());
 assert.equal((await integration.scheduler.tick()).ok,true);
 const state=JSON.parse(await fs.readFile(path.join(dir,'fanqie-goals.json'),'utf8'));
 assert.equal(Object.keys(state.events).length,1); assert.equal(Object.values(state.goals)[0].status,'completed');
});
