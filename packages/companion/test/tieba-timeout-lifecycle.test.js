import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { fetchPinned } from '../src/tieba-playwright.js';

const request = { url: () => 'https://tieba.baidu.com/p/1', method: () => 'GET' };
test('DNS resolution is bounded and a late result cannot initiate HTTPS', async () => {
  let finish;
  const started = Date.now();
  const result = fetchPinned(request, 30, undefined, () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(result, /timeout/);
  assert.ok(Date.now() - started < 1000);
  finish(['8.8.8.8']);
});
test('many pending requests share cancellation without accumulating parent listeners', async () => {
  const controller = new AbortController();
  const tasks = Array.from({length: 25}, () => fetchPinned(request, 5000, controller.signal, () => new Promise(() => {})));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(getEventListeners(controller.signal, 'abort').length <= 1);
  controller.abort();
  const results = await Promise.allSettled(tasks);
  assert.ok(results.every(x => x.status === 'rejected'));
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
