import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDouyinFailure } from '../src/douyin-result.js';

test('failed browse results preserve the reason without assuming a video', () => {
  const hint = formatDouyinFailure({ success: false, reason: '滑块验证' });
  assert.match(hint, /滑块验证/);
  assert.match(hint, /未能|失败/);
});
test('error-only results preserve the error', () => {
  assert.match(formatDouyinFailure({ success: false, error: '网络失败' }), /网络失败/);
});
