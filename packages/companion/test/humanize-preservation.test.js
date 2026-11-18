import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Humanizer } from '../src/humanize.js';

test('长回复不丢失标点后的内容', () => {
  const h = new Humanizer({ typoRate: 0 });
  const input = '这是一段需要认真解释的文字，需要交代背景、条件和细节，而不是只说开头。接下来还有非常重要的补充内容，不能被截断';
  assert.equal(h.split(input).join(''), input);
});

test('超长无标点文本完整保留', () => {
  const input = '这是没有标点但仍然需要全部发送出去的认真说明'.repeat(8);
  assert.equal(new Humanizer().split(input).join(''), input);
});

test('超限换行和 CQ 图片及 @ 按原顺序合并', () => {
  const input = '第一行内容\n第二行内容\n[CQ:image,file=abc.jpg]\n第三行[CQ:at,qq=123]继续说\n第四行内容';
  const parts = new Humanizer().split(input, 2);
  assert.ok(parts.length <= 2);
  assert.equal(parts.join('\n').replace(/\n+/g, ''), input.replace(/\n+/g, ''));
});

test('模拟 say 发送完整长内容', async () => {
  const h = new Humanizer({ typoRate: 0, gapRange: [0, 0], longGapChance: 0 });
  const input = '认真的回答不能丢掉任何细节'.repeat(9);
  const sent = [];
  const result = await h.say(input, { send: async p => sent.push(p), sleep: async () => {} });
  assert.equal(sent.join(''), input);
  assert.equal(result.sent, sent.length);
});

test('默认发送不主动增删或替换正文', async () => {
  const h = new Humanizer();
  const sent = [];
  const input = '这是一个需要仔细说明的内容而且不能把字删掉';
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    await h.say(input, { send: async p => sent.push(p), sleep: async () => {} });
  } finally {
    Math.random = originalRandom;
  }
  assert.equal(sent.join(''), input);
});

test('换行及 CQ 码按原样保留', () => {
  const h = new Humanizer({ stripPeriod: false });
  assert.equal(h.split('今天好累啊\n早点休息吧').join(''), '今天好累啊\n早点休息吧');
  const input = '第一段文字\n第二段文字\n[CQ:image,file=abc.jpg]\n第三段[CQ:at,qq=123]文字\n最后一段文字';
  assert.equal(h.split(input, 2).join(''), input);
});

test('分句处的空格不被删除', () => {
  const input = '这是足够长的一段说明用来触发自然分句而且包含很多必要的信息和条件需要完整保留。  后面还有补充内容';
  assert.equal(new Humanizer().split(input).join(''), input);
});

test('普通空格、粗体标记及字面零宽字符不丢失', () => {
  const input = 'Hello  World **important**\u200B文字说明';
  assert.equal(new Humanizer({ stripPeriod: false }).split(input).join(''), input);
});
