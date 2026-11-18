import test from 'node:test';
import assert from 'node:assert/strict';
import { executeSearchTool } from '../src/search-tools.js';
import { publicSearchQuery } from '../src/search-privacy.js';
import http from 'node:http';
import { EventEmitter } from 'node:events';

test('personal medical questions never reach a search provider', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected external request'); });
  for (const query of ['张三癌症治疗原理是什么', '李四艾滋病传播原理是什么']) {
    assert.equal(publicSearchQuery(query), '', query);
    assert.equal((await executeSearchTool('web_search', {query})).success, false);
  }
  assert.equal(calls, 0);
});

test('tomorrow weather forecasts can contain both today and tomorrow dates', async t => {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const date = d => `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`;
  t.mock.method(globalThis, 'fetch', async () => ({ok:true,json:async()=>({results:[{title:'北京天气预报',content:`${date(today)}发布：${date(tomorrow)}北京天气晴`,url:'https://example.invalid/weather'}]})}));
  const result = await executeSearchTool('web_search', {query:'北京天气明天'});
  assert.equal(result.success, true);
  assert.match(result.text, /时效未经核验/);
});

test('synthetic secrets, contact details and explicit prohibitions never leave the process', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected'); });
  t.mock.method(http, 'request', () => { calls++; throw Error('unexpected'); });
  for (const query of ['北京天气 13800138000', 'RTX 5080 密钥 sk-test-fake', '北京天气 alice@example.invalid', '不要查北京天气', '张三癌症治疗原理是什么', '李四工资计算原理是什么']) {
    assert.equal((await executeSearchTool('web_search', {query})).success, false, query);
  }
  assert.equal(calls, 0);
});

test('irrelevant results from every provider produce an honest failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ok:true,json:async()=>({results:[{title:'毫不相干',content:'无关内容'}]})}));
  t.mock.method(http, 'request', () => { const req = new EventEmitter(); req.end = () => queueMicrotask(() => req.emit('error', Error('offline'))); return req; });
  const result = await executeSearchTool('web_search', {query:'RTX 5080 显存容量是多少'});
  assert.equal(result.success, false);
  assert.match(result.text, /未找到.*相关搜索结果或网络连接超时/);
});
