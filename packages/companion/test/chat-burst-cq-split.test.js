import test from 'node:test';
import assert from 'node:assert/strict';
import { Humanizer } from '../src/humanize.js';
import { prepareConciseReply, safeReplyParts } from '../src/chat-concise-delivery.js';
import { splitBurst } from '../src/burst-split.js';

test('表情包与文字分成三个完整气泡', () => {
  const input = '又拍 [CQ:image,file=x] 我这脑袋是公用的吗，一天到晚谁来都要敲两下';
  const parts = new Humanizer().split(input);
  assert.equal(parts.length, 3);
  assert.equal(parts[1].trim(), '[CQ:image,file=x]');
  assert.equal(parts.join(''), input);
  assert(safeReplyParts(parts));
});

test('@ 与后续原句文字留在同一气泡', () => {
  const input = '[CQ:at,qq=123] 你干嘛呢 这么晚还不睡';
  const parts = new Humanizer().split(input);
  assert.equal(parts.join(''), input);
  assert(parts.some(part => part.includes('[CQ:at,qq=123]') && part.includes('你干嘛呢 这么晚还不睡')));
  assert(safeReplyParts(parts));
});

test('普通自然长句在句末拆分并保留原文', () => {
  const input = '今天我终于把事情都做完了。现在可以好好休息一下啦！';
  const parts = new Humanizer().split(input);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(''), input);
  assert(safeReplyParts(parts));
});

test('链接、行内代码和代码块所在整段不拆', () => {
  const h = new Humanizer();
  for (const input of ['看看 https://example.com/a。还有后面的文字！', '这段 `a.b()` 很重要。不要拆开哦！', '试试代码```js\nx()\n```然后告诉我。']) {
    assert.deepEqual(h.split(input), [input]);
  }
});

test('超出条数时合并且保留每个 CQ 码及全部字符', () => {
  const input = '甲[CQ:image,file=a]乙[CQ:image,file=b]丙';
  for (const max of [1, 2, 3, 9]) {
    const parts = new Humanizer({burstMax: max}).split(input);
    assert(parts.length <= Math.min(max, 3));
    assert.equal(parts.join(''), input);
    assert(safeReplyParts(parts));
  }
});

test('带表情包的长内容不会绕过 50 码点硬限', () => {
  const input = '甲'.repeat(45) + '[CQ:image,file=x]';
  assert(!safeReplyParts(new Humanizer().split(input)));
});

test('实际简洁发送准备保持分条与失败静默', async () => {
  const input = '又拍 [CQ:image,file=x] 我这脑袋是公用的吗，一天到晚谁来都要敲两下';
  const prepared = await prepareConciseReply(input, () => { throw Error('不得改写'); });
  assert.equal(prepared.parts.length, 3);
  assert.equal(prepared.parts.join(''), input);
  assert(safeReplyParts(prepared.parts));
  let attempts = 0;
  const rejected = await prepareConciseReply('字'.repeat(51), async () => { attempts++; return ''; });
  assert.equal(attempts, 5);
  assert.deepEqual(rejected.parts, []);
  assert.equal(rejected.failed, true);
});

test('线上 splitter 默认行为保持原样', () => {
  assert.deepEqual(splitBurst('短句'), ['短句']);
  assert.deepEqual(splitBurst('又拍 [CQ:image,file=x] 我这脑袋是公用的吗，一天到晚谁来都要敲两下'),
    ['又拍', '[CQ:image,file=x]', '我这脑袋是公用的吗，一天到晚谁来都要敲两下']);
});
