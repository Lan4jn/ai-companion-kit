import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSearchQuery } from '../src/search-privacy.js';
import { browseWebTopic } from '../src/web-living.js';

test('ordinary bounded public science questions are searchable without a topic list', () => {
  for (const q of ['光合作用是什么？', '请查一下光合作用是什么？', '什么是量子计算？', '法国首都是哪里？']) assert.equal(publicSearchQuery(q), q);
});

test('explicit no-search on a surfing prompt overrides the hot-list trigger', async () => {
  let calls = 0; const old = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw Error('unexpected network'); };
  try {
    const result = await browseWebTopic({ brain: {}, memory: {dir: process.env.HOME}, prompt: '不要搜索，看看热榜' });
    assert.equal(result.success, false);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = old; }
});

test('private data cannot hide in an otherwise public-looking question', () => {
 for (const q of ['光合作用张三住址是什么？', '《张三的病历》游戏最新消息', '不要查光合作用是什么？', '光合作用 abcdef 是什么？']) assert.equal(publicSearchQuery(q), '');
});
