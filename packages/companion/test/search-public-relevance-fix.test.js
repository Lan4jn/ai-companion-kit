import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicSearchQuery } from '../src/search-privacy.js';
import { executeSearchTool } from '../src/search-tools.js';

test('bounded public fact questions pass without declassifying private additions', () => {
  for (const q of ['2024年诺贝尔物理学奖获得者是谁', 'RTX 5080 显存容量是多少', '北京天气']) assert.equal(publicSearchQuery(q), q);
  for (const q of ['2024年诺贝尔物理学奖获得者张三的病情是什么', 'RTX 5080 显存容量是多少 张三', '北京天气 我家地址', '不要搜索北京天气']) assert.equal(publicSearchQuery(q), '');
});

test('unrelated first results do not suppress relevant results from same provider', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => ({ok:true,json:async()=>({results:[{title:'天气新闻',content:'天气',url:'https://example.org/a'}, {title:'RTX 5080 规格',content:'显存16GB',url:'https://example.org/b'}]})});
  try {
    const r = await executeSearchTool('web_search', {query:'RTX 5080 显存容量是多少'});
    assert.equal(r.success, true); assert.match(r.text, /RTX 5080/); assert.doesNotMatch(r.text, /天气新闻/);
  } finally { globalThis.fetch = old; }
});
