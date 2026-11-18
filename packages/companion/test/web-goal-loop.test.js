import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { browseWebTopic } from '../src/web-living.js';
import { createGoalCore } from '../src/goal-core.js';

const dir = () => fs.mkdtempSync(path.join(process.env.TMPDIR || '/root/.hermes/cache/scratch', 'web-goal-'));
const brain = { complete: async ({ prompt }) => prompt.includes('想不想再花几分钟') ? { deep: true, why: '想了解' } : prompt.includes('提炼出') ? { learned: [] } : { details: '看了一些资料', mood: '继续了解' } };

test('unreadable source leaves unverified snippets unknown without evidence after reopen', async () => {
  const dataDir = dir();
  const search = async () => ({ success: true, text: '1. 【怪物猎人荒野】\n怪物猎人荒野的真实搜索摘要\n(来源: web https://example.com/article)' });
  const result = await browseWebTopic({ brain, memory: { dir: dataDir }, topic: '怪物猎人荒野', search, readEvidence: async()=>{throw Error('unavailable')}, });
  const snapshot = createGoalCore({ file: path.join(dataDir, 'web-goals.json') }).snapshot();
  const goal = Object.values(snapshot.goals)[0];
  const desire = Object.values(snapshot.desires)[0];
  assert.equal(result.goalStatus, 'unknown');
  assert.equal(goal.status, 'active');
  assert.equal(goal.progress, 0);
  assert.equal(desire.status, 'active');
  assert.equal(desire.outcomeEventId, undefined);
  assert.deepEqual(snapshot.events, {});
  assert.equal(fs.existsSync(path.join(dataDir, 'web-goal-evidence')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'web-knowledge.jsonl')), false);
});

test('failed supplemental search and unreadable source remain unknown, not refused or progress', async () => {
  const dataDir = dir();
  let calls = 0;
  const result = await browseWebTopic({ brain, memory: { dir: dataDir }, topic: '怪物猎人荒野', readEvidence:async()=>{throw Error('unavailable')}, search: async () => ++calls === 1
    ? ({ success: true, text: '1. 【怪物猎人荒野】\n怪物猎人荒野的真实搜索摘要\n(来源: web https://example.com/article)' })
    : ({ success: false, text: '搜索失败' }) });
  const snapshot = createGoalCore({ file: path.join(dataDir, 'web-goals.json') }).snapshot();
  assert.equal(result.goalStatus,'unknown');
  assert.equal(Object.values(snapshot.desires)[0].status, 'active');
  assert.equal(Object.values(snapshot.goals)[0].status, 'active');
  assert.deepEqual(snapshot.events,{});
  assert.equal(Object.values(snapshot.goals)[0].progress, 0);
});
