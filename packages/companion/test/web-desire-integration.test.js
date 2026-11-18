import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browseWebTopic } from '../src/web-living.js';
import * as desires from '../src/desire-engine.js';

const dir = () => fs.mkdtempSync(path.join(process.env.TMPDIR, 'web-desire-'));
const topic = '怪物猎人荒野';
const quote = `${topic}包含一个公开测试内容`;
const brain = { complete: async ({ prompt }) => prompt.includes('想不想再花几分钟') ? { deep: true, why: '想了解版本变化' } : prompt.includes('页面证据') ? {relevant:true,quote} : prompt.includes('是否想把这段原文') ? {interested:false} : { details: '看了一些资料', mood: '继续了解' } };

test('a model-formed web desire is visible through the desire engine after the actual search outcome and reload', async () => {
  const dataDir = dir();
  const queries = [];
  const result = await browseWebTopic({ brain, memory: { dir: dataDir }, topic, readEvidence:async()=>({url:'https://example.com/article',text:quote}), search: async (_tool, { query }) => {
    queries.push(query);
    return { success: true, text: `1. 【${topic}】\n${topic}的版本更新内容\n(来源: web https://example.com/article)` };
  } });
  assert.ok(queries.includes(`${topic} 是什么`));
  assert.equal(typeof desires.getWebDesireHistory, 'function');
  const [entry] = desires.getWebDesireHistory(dataDir);
  assert.equal(entry.topic, topic);
  assert.equal(entry.reason, '想了解版本变化');
  assert.equal(result.goalStatus,'completed');
  assert.equal(entry.status, 'completed');
  assert.equal(entry.goal.status, 'completed');
  const evidence = JSON.parse(fs.readFileSync(entry.evidence.ref, 'utf8'));
  assert.equal(evidence.topic, topic); assert.equal(evidence.quote,quote);
  desires.initDesireEngine(dataDir);
  assert.doesNotMatch(desires.renderDesirePrompt('web'), /怪物猎人荒野|搜索摘要/);
});
