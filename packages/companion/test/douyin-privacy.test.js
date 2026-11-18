import test from 'node:test';
import assert from 'node:assert/strict';
import { submitDouyinComment } from '../src/douyin-living.js';

test('Douyin blocks private identifiers before touching the editor', async () => {
  let calls = 0;
  const send = async () => { calls++; return true; };
  assert.equal(await submitDouyinComment('联系123456789', ['123456789'], send), false);
  assert.equal(await submitDouyinComment('[CQ:at,qq=123456789]', ['123456789'], send), false);
  assert.equal(await submitDouyinComment('正常评论', undefined, send), false);
  assert.equal(await submitDouyinComment('正常评论', [], send), false);
  assert.equal(calls, 0);
  assert.equal(await submitDouyinComment('正常评论', ['123456789'], send), true);
  assert.equal(calls, 1);
});
