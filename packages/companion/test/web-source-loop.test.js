import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browseWebTopic } from '../src/web-living.js';
import { createGoalCore } from '../src/goal-core.js';

test('a model-selected relevant page with exact source quotation closes the desire with persisted evidence', async () => {
 const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'web-close-'));
 try {
  const topic='怪物猎人荒野'; const text='怪物猎人荒野包含一个公开测试内容，这是用于验证来源证据的真实页面文本。';
  const search=async()=>({success:true,text:`1. 【${topic}】\n${topic}的相关资料\n(来源: web https://example.com/article)`});
  const brain={complete:async({prompt})=>prompt.includes('想不想再花')?{deep:true,why:'想了解'}:prompt.includes('页面证据')?{relevant:true,quote:'怪物猎人荒野包含一个公开测试内容',learned:'怪物猎人荒野包含一个公开测试内容'}:{details:'看到一条公开测试内容',mood:'想继续看看'} };
  await browseWebTopic({brain,memory:{dir},topic,search,readEvidence:async()=>({url:'https://example.com/article',text,sha256:'a'.repeat(64),fetchedAt:Date.now()})});
  const snap=createGoalCore({file:path.join(dir,'web-goals.json')}).snapshot();
  const d=Object.values(snap.desires)[0]; assert.equal(d.status,'completed');
  const e=snap.events[d.outcomeEventId]; assert.equal(e.evidence.source,'web-source-page');
  const saved=JSON.parse(fs.readFileSync(e.evidence.ref)); assert.equal(saved.quote,'怪物猎人荒野包含一个公开测试内容');
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
