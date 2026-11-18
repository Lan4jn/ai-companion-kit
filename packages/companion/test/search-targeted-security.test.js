import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSearchTool } from '../src/search-tools.js';
import { createTrendingCapability } from '../src/search-privacy.js';

test('search provider redirects cannot forward custom authorization headers', async () => {
  const original = globalThis.fetch;
  const observed = [];
  globalThis.fetch = async (url, options) => {
    observed.push(options.redirect);
    return { ok: true, json: async () => ({ results: [{title:'RTX 5080 规格', content:'RTX 5080 显存16GB'}] }) };
  };
  try {
    const result = await executeSearchTool('web_search', {query:'RTX 5080 显存容量是多少'});
    assert.equal(result.success, true);
    assert.deepEqual(observed, ['error']);
  } finally { globalThis.fetch = original; }
});

test('GPU model number is not matched as a prefix of a different number', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ok:true, json:async()=>({results:[
    {title:'RTX 50800 规格',content:'显存128GB'},
    {title:'RTX 5080 规格',content:'显存16GB'}
  ]})});
  try {
    const result = await executeSearchTool('web_search', {query:'RTX 5080 显存容量是多少'});
    assert.equal(result.success, true);
    assert.match(result.text, /RTX 5080 规格/);
    assert.doesNotMatch(result.text, /50800/);
  } finally { globalThis.fetch = original; }
});

test('health status of a named person cannot become a trending search capability', () => {
  assert.equal(createTrendingCapability('张三患乙肝'), null);
});

test('public safety headlines with benign 患 compounds remain searchable', () => {
  for (const title of ['消防安全隐患排查', '城市防洪消除后患', '忧患意识与安全教育']) {
    assert.ok(createTrendingCapability(title), title);
  }
  for (const title of ['张三患乙肝', '李四患难治性疾病', '张三患有罕见病', '张三婚后患乙肝', '张三隐患乙肝']) {
    assert.equal(createTrendingCapability(title), null, title);
  }
});
