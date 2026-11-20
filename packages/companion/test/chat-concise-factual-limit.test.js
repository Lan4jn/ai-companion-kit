import test from 'node:test';
import assert from 'node:assert/strict';
import { safeReplyParts, safeTransportMessage, prepareConciseReply } from '../src/chat-concise-delivery.js';

const repeat = n => '鱼'.repeat(n);

test('默认上限仍是 50：51~80 码点的普通回复不放行', () => {
  assert.equal(safeReplyParts([repeat(50)]), true);
  assert.equal(safeReplyParts([repeat(51)]), false);
  assert.equal(safeReplyParts([repeat(80)]), false);
  assert.equal(safeTransportMessage(repeat(70)), false);
});

test('科普档 80：80 码点以内放行，81 码点拒绝', () => {
  assert.equal(safeReplyParts([repeat(80)], 80), true);
  assert.equal(safeReplyParts([repeat(81)], 80), false);
  assert.equal(safeTransportMessage(repeat(80), 80), true);
  // 不允许超过 80 的档位，避免被调用方悄悄放宽
  assert.equal(safeReplyParts([repeat(100)], 999), false);
});

test('prepareConciseReply 在 80 档下不重写直接通过', async () => {
  const text = repeat(72);
  let rewrites = 0;
  const out = await prepareConciseReply(text, async () => { rewrites++; return repeat(10); }, async () => true, { softLimit: 80 });
  assert.equal(out.failed, undefined);
  assert.equal(out.rewritten, undefined);
  assert.equal(out.parts.join(''), text);
  assert.equal(rewrites, 0);
});

test('prepareConciseReply 默认档遇到 72 码点会走重写', async () => {
  const text = repeat(72);
  let rewrites = 0;
  const out = await prepareConciseReply(text, async () => { rewrites++; return repeat(20); }, async () => true);
  assert.equal(rewrites >= 1, true);
  assert.equal(out.failed, undefined);
  assert.equal([...out.parts.join('')].length <= 50, true);
});
