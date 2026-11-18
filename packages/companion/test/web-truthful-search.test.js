import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browseWebTopic } from '../src/web-living.js';
import { createGoalCore } from '../src/goal-core.js';

function assertOnlyClaim(dir, status) {
  assert.deepEqual(fs.readdirSync(dir).sort(), ['web-goals.json','web-goals.json.lock']);
  const snapshot=createGoalCore({file:path.join(dir,'web-goals.json')}).snapshot();
  const desire=Object.values(snapshot.desires)[0]; const goal=Object.values(snapshot.goals)[0];
  assert.equal(desire.status,status); assert.equal(goal.status,status); assert.equal(goal.progress,0);
  if (status==='active') assert.deepEqual(snapshot.events,{});
  else assert.equal(snapshot.events[desire.outcomeEventId].type,'desire.failed');
}

const dir = () => fs.mkdtempSync(path.join(process.env.TMPDIR, 'web-truth-'));

test('failed search never invokes the model or saves fabricated surfing', async () => {
  const dataDir = dir();
  let calls = 0;
  const diary = [];
  const result = await browseWebTopic({
    topic: '怪物猎人荒野', memory: { dir: dataDir, logDiary: entry => diary.push(entry) },
    search: async () => ({ success: false, text: '搜索失败' }),
    brain: { complete: async () => { calls++; return { details: '虚构事件', mood: '虚构感想' }; } },
  });
  assert.equal(result.success, false);
  assert.equal(calls, 0);
  assert.deepEqual(diary, []);
  assert.equal(result.goalStatus,'unknown');
  assertOnlyClaim(dataDir, 'active');
});

test('success without source or content is rejected, including exceptions', async () => {
  for (const search of [
    async () => ({ success: true, text: '搜索失败' }),
    async () => ({ success: true, text: '怪物猎人荒野 (来源: web https://example.com/)' }),
    async () => ({ success: true, text: '1. 【天气预报】\n北京天气晴朗\n(来源: web https://example.com/weather)' }),
    async () => { throw new Error('offline'); },
  ]) {
    const dataDir = dir();
    const diary = [];
    const result = await browseWebTopic({ topic: '怪物猎人荒野', memory: { dir: dataDir, logDiary: x => diary.push(x) }, search,
      brain: { complete: async () => { throw new Error('model must not run'); } } });
    assert.equal(result.success, false);
    assert.deepEqual(diary, []);
    assert.equal(result.goalStatus,'unknown');
    assertOnlyClaim(dataDir, 'active');
  }
});

test('digest failure is propagated rather than inventing a diary entry', async () => {
  const dataDir = dir();
  const diary = [];
  const result = await browseWebTopic({ topic: '怪物猎人荒野', memory: { dir: dataDir, logDiary: x => diary.push(x) },
    search: async () => ({ success: true, text: '1. 【怪物猎人荒野】\n怪物猎人荒野的真实搜索摘要\n(来源: web https://example.com/article)' }),
    brain: { complete: async ({prompt}) => { if (prompt.includes('想不想再花')) return { deep: false }; throw new Error('offline'); } } });
  assert.equal(result.success, false);
  assert.deepEqual(diary, []);
  assert.equal(result.goalStatus,'failed');
  assertOnlyClaim(dataDir, 'failed');
});

test('sourced relevant search results still produce a diary', async () => {
  const dataDir = dir();
  const diary = [];
  const result = await browseWebTopic({ topic: '怪物猎人荒野', memory: { dir: dataDir, logDiary: x => diary.push(x) },
    search: async () => ({ success: true, text: '1. 【怪物猎人荒野】\n怪物猎人荒野的真实搜索摘要\n(来源: web https://example.com/article)' }),
    brain: { complete: async ({prompt}) => prompt.includes('想不想再花') ? {deep:false} : {details:'怪物猎人荒野的搜索摘要', mood:'有点意思'} } });
  assert.equal(result.success, true);
  assert.equal(diary.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'web-surfing-history.json')))[0].topic, '怪物猎人荒野');
});
