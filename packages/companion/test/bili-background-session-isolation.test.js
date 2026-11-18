import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug } from '../src/bili-living.js';

test('B站自主浏览决策不读取无来源的私聊或群聊日记', async () => {
  let prompt = '';
  const memory = {dir: process.env.HOME, recentDiary: async () => [
    {category:'私聊', activity:'主人秘密苹果'},
    {category:'群聊', details:'群友秘密香蕉'},
  ]};
  const result = await __debug.decideBiliBrowsing({complete: async p => {prompt = p.prompt; return '{"want":true}';}}, memory, {todayCount:0}, new AbortController().signal);
  assert.equal(result, true);
  assert.doesNotMatch(prompt, /主人秘密苹果|群友秘密香蕉/);
});
