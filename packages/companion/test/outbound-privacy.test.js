import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutboundPrivacy } from '../src/outbound-privacy.js';

test('blocks configured owner ID in outbound text', () => {
  assert.deepEqual(checkOutboundPrivacy('我的QQ是123456789', ['123456789']), { safe: false, reason: 'owner_id' });
});

test('blocks common owner ID obfuscations', () => {
  for (const text of ['１２３４５６７８９', '123 456 789', '123-456-789', '1\u200b2\u200b3\u200b4\u200b5\u200b6\u200b7\u200b8\u200b9', '１２３．４５６．７８９']) {
    assert.equal(checkOutboundPrivacy(text, ['123456789']).safe, false, text);
  }
});

test('blocks CQ codes including case and fullwidth variants', () => {
  for (const text of ['[CQ:at,qq=123]', '[cq:image,file=foo]', '［ＣＱ：ａｔ，ｑｑ＝１２３］', '[ CQ : at,qq=all ]']) {
    assert.deepEqual(checkOutboundPrivacy(text), { safe: false, reason: 'cq_code' }, text);
  }
});

test('allows ordinary text and unrelated numbers', () => {
  for (const text of ['你好，今天心情不错！', '价格是123.45元', 'CQ是个字母缩写', '123456780', '']) {
    assert.deepEqual(checkOutboundPrivacy(text, ['123456789']), { safe: true, reason: null }, text);
  }
});

test('ignores empty or malformed owner IDs rather than matching everything', () => {
  assert.equal(checkOutboundPrivacy('normal', ['', null, undefined]).safe, true);
});

test('handles multiple numeric and fullwidth configured IDs', () => {
  assert.equal(checkOutboundPrivacy('联系987654321', [123456789, '９８７６５４３２１']).reason, 'owner_id');
});

test('fails closed for non-string messages and rejects invalid ID lists', () => {
  assert.deepEqual(checkOutboundPrivacy(null, ['123456789']), { safe: false, reason: 'invalid_text' });
  assert.throws(() => checkOutboundPrivacy('text', '123456789'), TypeError);
});
