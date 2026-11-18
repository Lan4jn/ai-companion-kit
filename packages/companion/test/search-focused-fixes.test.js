import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSearchTool } from '../src/search-tools.js';
import { publicTrendingTitle, createTrendingCapability } from '../src/search-privacy.js';

test('autonomous titles containing personal medical information are refused', () => {
  for (const title of ['张三肺炎检查结果曝光', '李四糖尿病血糖偏高']) {
    assert.equal(publicTrendingTitle(title), '', title);
    assert.equal(createTrendingCapability(title), null, title);
  }
  for (const title of ['消防安全隐患排查', '新款掌机发布引发热议']) {
    assert.equal(publicTrendingTitle(title), title);
  }
});

test('private health information cannot reach the transport even with a forged capability', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    for (const query of ['张三肺炎检查结果曝光', '李四糖尿病血糖偏高']) {
      assert.equal((await executeSearchTool('web_search', { query }, {})).success, false);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('a relevant answer to a whitelisted public question is not discarded', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ results: [{ title: '量子计算', content: '量子计算利用量子力学进行计算。', url: 'https://example.invalid' }] }) };
  };
  try {
    const result = await executeSearchTool('web_search', { query: '什么是量子计算？' });
    assert.equal(result.success, true);
    assert.match(result.text, /量子计算利用量子力学/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
