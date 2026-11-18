import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browseWebTopic, renderWebKnowledge } from '../src/web-living.js';
import { createGoalCore } from '../src/goal-core.js';

const topic='怪物猎人荒野';
const makeDir=()=>fs.mkdtempSync(path.join(process.env.TMPDIR,'web-integrity-'));
const search=async()=>({success:true,text:`1. 【${topic}】\n${topic}相关资料\n(来源: web https://example.com/article)`});
const run=(dir,quote,diary=[])=>browseWebTopic({topic,search,memory:{dir,logDiary:x=>diary.push(x)},readEvidence:async()=>({url:'https://example.com/article',text:`${topic}相关新闻。${topic}包含一个公开测试内容。今天天气晴朗适合外出散步。`,sha256:'a'.repeat(64)}),brain:{complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true,why:'看看'}:prompt.includes('页面证据')?{relevant:true,quote}:{details:'未经证实的摘要宣称某事件发生',mood:'有点意思'}}});

test('unrelated exact quote cannot complete target or be presented as a verified fact',async()=>{
 const dir=makeDir(), diary=[];
 const result=await run(dir,'今天天气晴朗适合外出散步',diary);
 const snap=createGoalCore({file:path.join(dir,'web-goals.json')}).snapshot();
 assert.notEqual(Object.values(snap.goals)[0].status,'completed');
 assert.deepEqual(result.learned,[]);
 assert.ok(!JSON.stringify(diary).includes('未经证实的摘要宣称某事件发生'));
 });

 test('a read source is not an independently verified fact or unconditional knowledge',async()=>{
 const dir=makeDir(), diary=[];
 const result=await run(dir,'怪物猎人荒野相关新闻',diary);
 assert.deepEqual(result.learned,[]);
 assert.ok(!fs.existsSync(path.join(dir,'web-knowledge.jsonl')));
 assert.ok(!JSON.stringify(diary).includes('未经证实的摘要宣称某事件发生'));
});

test('legacy unverified knowledge is not injected as established fact',()=>{
 const dir=makeDir();
 fs.writeFileSync(path.join(dir,'web-knowledge.jsonl'),JSON.stringify({learned:['来源未核实的旧摘要内容']})+'\n');
 assert.equal(renderWebKnowledge(dir),'');
});

test('a failed deep-search goal is reported explicitly',async()=>{
 const result=await run(makeDir(),'今天天气晴朗适合外出散步');
 assert.equal(result.goalStatus,'failed');
});

test('goal persistence failure is surfaced rather than reported as successful browsing',async()=>{
 const dir=makeDir();
 fs.writeFileSync(path.join(dir,'web-goal-evidence'),'block');
 const result=await run(dir,'怪物猎人荒野包含一个公开测试内容');
 assert.equal(result.success,false);
 const snap=createGoalCore({file:path.join(dir,'web-goals.json')}).snapshot();
 assert.equal(Object.values(snap.goals)[0].status,'active');
});

test('persisted unverified snippet remains unknown, never a completion',async()=>{
 const dir=makeDir(), core=createGoalCore({file:path.join(dir,'web-goals.json')});
 core.ensureGoalDesire({goal:{id:'snippet',title:JSON.stringify({kind:'web-deep-search',topic}),target:1},desire:{id:'snippet',title:'深入搜索',goalId:'snippet'}});
 fs.mkdirSync(path.join(dir,'web-goal-evidence'));
 fs.writeFileSync(path.join(dir,'web-goal-evidence','snippet.json'),JSON.stringify({topic,verification:'search-snippet-topic-match; source-page-not-verified'}));
 await browseWebTopic({topic,memory:{dir},search:async()=>({success:false}),brain:{complete:async()=>{throw Error('must not run')}}});
 assert.equal(core.snapshot().goals.snippet.status,'active');
 assert.equal(Object.keys(core.snapshot().events).length,0);
});

test('untrusted persisted page evidence does not automatically close an interrupted goal',async()=>{
 const dir=makeDir();
 const core=createGoalCore({file:path.join(dir,'web-goals.json')});
 const title=JSON.stringify({kind:'web-deep-search',topic,reason:'看看'});
 core.ensureGoalDesire({goal:{id:'recover',title,target:1},desire:{id:'recover',title:'深入搜索',goalId:'recover'}});
 fs.mkdirSync(path.join(dir,'web-goal-evidence'));
 fs.writeFileSync(path.join(dir,'web-goal-evidence','recover.json'),JSON.stringify({topic,url:'https://example.com/article',text:`${topic}包含一个公开测试内容`,quote:`${topic}包含一个公开测试内容`,verification:'source-page-read; model-relevance; exact-topic-quote; facts-not-independently-verified'}));
 for(let i=0;i<2;i++) await browseWebTopic({topic,memory:{dir},search:async()=>({success:false}),brain:{complete:async()=>{throw Error('must not run')}}});
 const snap=core.snapshot();
 assert.equal(snap.goals.recover.status,'active');
 assert.equal(Object.keys(snap.events).length,0);
});
