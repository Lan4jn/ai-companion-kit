import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSearchQuery } from '../src/search-privacy.js';
import { executeSearchTool } from '../src/search-tools.js';

test('standalone public Nobel and Beijing weather searches pass without declassifying private text', () => {
  for (const q of ['诺贝尔物理学奖 2024', '2024年诺贝尔物理学奖获奖者是谁', '北京天气 今天', '今天北京天气怎么样']) assert.equal(publicSearchQuery(q), q, q);
  for (const q of ['诺贝尔物理学奖 2024 我的病历', '北京天气 今天 我的家庭住址', '不要搜索北京天气 今天', '北京天气 今天 张三住在朝阳区']) assert.equal(publicSearchQuery(q), '', q);
});

test('SearXNG budget accommodates a slow aggregation and discards wrong Nobel year', async () => {
  const fetch0 = globalThis.fetch, timeout0 = AbortSignal.timeout;
  let timeout;
  AbortSignal.timeout = ms => { timeout = ms; return timeout0(ms); };
  globalThis.fetch = async () => ({ok:true,json:async()=>({results:[
    {title:'2023年诺贝尔物理学奖',content:'诺贝尔物理学奖得主',url:'https://example.org/2023'},
    {title:'2024年诺贝尔物理学奖',content:'诺贝尔物理学奖得主',url:'https://example.org/2024'}]})});
  try {
    const result = await executeSearchTool('web_search', {query:'诺贝尔物理学奖 2024'});
    assert.equal(result.success,true);
    assert.ok(timeout >= 12000);
    assert.match(result.text,/2024年诺贝尔/);
    assert.doesNotMatch(result.text,/2023年诺贝尔/);
  } finally { globalThis.fetch = fetch0; AbortSignal.timeout = timeout0; }
});

test('weather search rejects explicitly stale dates and warns undated snippets are unverified', async () => {
  const fetch0 = globalThis.fetch;
  globalThis.fetch = async () => ({ok:true,json:async()=>({results:[
    {title:'北京天气预报',content:'2001年11月3日 北京天气晴'},
    {title:'北京天气预报',content:'北京天气请查看官网实时数据'}]})});
  try {
    const result = await executeSearchTool('web_search', {query:'北京天气 今天'});
    assert.equal(result.success,true);
    assert.doesNotMatch(result.text,/2001年11月3日/);
    assert.match(result.text,/时效|日期/);
  } finally { globalThis.fetch = fetch0; }
});
