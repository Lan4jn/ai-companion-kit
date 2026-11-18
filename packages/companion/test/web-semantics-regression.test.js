import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browseWebTopic } from '../src/web-living.js';
import { createGoalCore } from '../src/goal-core.js';
const dir=()=>fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch','web-semantics-'));
const topic='怪物猎人荒野';
const search=async()=>({success:true,text:`1. ${topic}的相关资料\n(来源: web https://example.com/a)`});
test('interrupted goal without evidence remains unknown after lease expiry',async()=>{
 const d=dir(), file=path.join(d,'web-goals.json');
 const core=createGoalCore({file});
 core.ensureGoalDesire({goal:{id:'interrupted',title:JSON.stringify({kind:'web-deep-search',topic,startedAt:Date.now()-3600000}),target:1},desire:{id:'interrupted',title:'深入搜索',goalId:'interrupted'}});
 const old=new Date(Date.now()-3600000); fs.utimesSync(file,old,old);
 let calls=0; const result=await browseWebTopic({topic,memory:{dir:d},search:async()=>{calls++;return {success:false}},brain:{complete:async()=>{throw Error('unexpected')}}});
 assert.equal(result.goalStatus,'unknown'); assert.equal(calls,0);
 assert.equal(core.snapshot().goals.interrupted.status,'active');
 assert.equal(core.snapshot().desires.interrupted.status,'active'); assert.deepEqual(core.snapshot().events,{});
});

test('read evidence survives digest failure as attributed unverified quotation with goal status',async()=>{
 const d=dir(), quote=`${topic}包含一个公开测试内容`;
 const brain={complete:async({prompt})=>{if(prompt.includes('想不想再花')) return {deep:true,why:'看看'}; if(prompt.includes('页面证据')) return {relevant:true,quote,learned:'编造的结论'}; throw Error('digest failed');}};
 const result=await browseWebTopic({topic,search,brain,memory:{dir:d},readEvidence:async()=>({url:'https://example.com/a',text:quote})});
 assert.equal(result.success,false);
 assert.equal(result.goalStatus,'completed');
 assert.deepEqual(result.learned,[`来源原文（未经独立核实）：${quote}`]);
 assert.ok(!JSON.stringify(result).includes('编造的结论'));
});

test('topic heading combined with unrelated weather is not evidence of topic information',async()=>{
 const d=dir(), quote=`${topic}。今天天气晴朗适合外出散步`;
 const brain={complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true,why:'看看'}:prompt.includes('页面证据')?{relevant:true,quote,learned:quote}:{details:'摘要',mood:'看看'}};
 const result=await browseWebTopic({topic,search,brain,memory:{dir:d},readEvidence:async()=>({url:'https://example.com/a',text:quote})});
 assert.equal(result.goalStatus,'failed');
 assert.equal(Object.values(createGoalCore({file:path.join(d,'web-goals.json')}).snapshot().goals)[0].status,'failed');
});
