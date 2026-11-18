import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFanqieIntegration } from '../src/fanqie-integration.js';
import { createGoalCore } from '../src/goal-core.js';
import { createFanqieGoalSave } from '../src/fanqie-goal.js';

test('observed reading for an existing desire advances its goal only once', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'fanqie-goal-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'goals.json')});
 core.addGoal({id:'g',title:'阅读已选书',target:2});
 core.addDesire({id:'d',title:'阅读一页',goalId:'g'});
 const text='真实正文'.repeat(20);
 const save=createFanqieGoalSave({core,desireId:'d',bookTitle:'证据书名',save:async()=>{}});
 const integration=createFanqieIntegration({serial:'test',brain:{complete:async()=>JSON.stringify({interested:true,continueReading:false,summary:'正文摘要',keywords:[]})},memoryDir:dir,want:async()=>true,mutex:{tryBackground:async fn=>{await fn();return true;}},online:async()=>true,navigate:async()=>({ok:true,bookTitle:'证据书名'}),progress:async()=>({chapter:'第一章',page:1,total:3}),capture:async()=>({text,source:'番茄小说屏幕OCR（可能存在识别错误）',fingerprint:createHash('sha256').update(text).digest('hex')}),save});
 assert.equal((await integration.run()).ok,true);
 assert.equal((await integration.run()).ok,true);
 const state=core.snapshot();
 assert.equal(state.goals.g.progress,1);
 assert.equal(state.desires.d.status,'completed');
 assert.equal(Object.keys(state.events).length,1);
});


test('a forged or incomplete reading record never advances a goal', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'fanqie-goal-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'goals.json')});
 core.addGoal({id:'g',title:'阅读',target:1});
 core.addDesire({id:'d',title:'阅读',goalId:'g'});
 const save=createFanqieGoalSave({core,desireId:'d',bookTitle:'书名',save:async()=>{}});
 const short='短文本';
 const valid={text:short,source:'番茄小说屏幕OCR（可能存在识别错误）',bookTitle:'书名',fingerprint:createHash('sha256').update(short).digest('hex'),progress:{page:1,total:2}};
 assert.equal((await save(dir,valid)).applied,false);
 assert.equal(core.snapshot().goals.g.progress,0);
});


test('a fabricated record outside the reading navigation context is rejected', async t => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'fanqie-goal-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const core=createGoalCore({file:path.join(dir,'goals.json')});
 core.addGoal({id:'g',title:'阅读',target:1});
 core.addDesire({id:'d',title:'阅读',goalId:'g'});
 const save=createFanqieGoalSave({core,desireId:'d',bookTitle:'书名',save:async()=>{}});
 const text='正文'.repeat(40);
 const record={text,source:'番茄小说屏幕OCR（可能存在识别错误）',bookTitle:'书名',fingerprint:createHash('sha256').update(text).digest('hex'),progress:{page:1,total:2}};
 assert.equal((await save(dir,record)).applied,false);
 assert.equal(core.snapshot().goals.g.progress,0);
});
