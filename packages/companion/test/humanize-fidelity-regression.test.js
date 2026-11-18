import test from 'node:test';
import assert from 'node:assert/strict';
import { Humanizer } from '../src/humanize.js';

const h = new Humanizer({ enabled: false });
test('短文本保留全部原始空白、转义及 CQ 内容', () => {
  for (const text of ['  a\r\n\r\nb  ', ' \\n\u2028\n[CQ:image,file=x] \n', '   ', '__CQ_IMAGE_0__']) {
    assert.equal(h.split(text).join(''), text);
  }
});
test('分段不拆 Hangul 字素', () => {
  const text = 'a'.repeat(999) + '가' + 'b'.repeat(20);
  const parts = h.split(text);
  assert.equal(parts.join(''), text);
  assert.ok(!parts.some(p => p.startsWith('ᅡ') || p.endsWith('ᄀ')));
});
test('超长不可分割项提前显式失败，不发送任何部分', async () => {
  for (const token of ['https://example.org/' + 'x'.repeat(1100), '[CQ:image,file=' + 'x'.repeat(1100) + ']', '```js\n' + 'x'.repeat(1100) + '\n```', 'a' + '\u0301'.repeat(1001)]) {
    const sent = [];
    const result = await h.say('前文'.repeat(600) + token, {send: async p => {sent.push(p); return {ok:true};}});
    assert.equal(result.ok, false);
    assert.match(result.error, /(?:超长|超过|过长)/);
    assert.equal(result.sent, 0);
    assert.deepEqual(sent, []);
  }
});
test('短文本启用模拟错字也不改变发送内容', async () => {
  const text = '这是的短文本需要完整保留每一个字';
  const sent = [];
  await new Humanizer({ typoRate: 1 }).say(text, {send: async p => {sent.push(p); return {ok:true};}, sleep: async () => {}});
  assert.equal(sent.join(''), text);
});

test('直接传入分段也不能绕过超长检查', async () => {
  let calls = 0;
  const result = await h.say(['前文', 'x'.repeat(1001)], {send: async () => { calls++; }});
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.equal(calls, 0);
});
