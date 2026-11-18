import test from 'node:test';
import assert from 'node:assert/strict';
import { Humanizer } from '../src/humanize.js';

test('长无标点文本连续无损分段，短文本不强制分段', () => {
  const h = new Humanizer({ enabled: false });
  const input = '汉字👨‍👩‍👧‍👦e\u0301'.repeat(500);
  const parts = h.split(input);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), input);
  assert.ok(parts.every(p => !p.startsWith('\u0301') && !p.startsWith('\u200d') && !p.endsWith('\u200d')));
  assert.deepEqual(h.split('短句。第二句'), ['短句。第二句']);
});

test('长代码及链接、CQ 消息完整按顺序传递', async () => {
  const h = new Humanizer({ enabled: false });
  const url = 'https://example.org/' + 'a'.repeat(300);
  const cq = '[CQ:image,file=base64://' + 'x'.repeat(300) + ']';
  const input = '头部'.repeat(300) + '\r\n```js\n' + 'const x = 1;\n'.repeat(30) + '```\n' + url + '\n' + cq + '\n结束'.repeat(100);
  const sent = [];
  const result = await h.say(input, { send: async part => { sent.push(part); return {ok:true, outcome:'confirmed'}; } });
  assert.ok(sent.length > 1 && sent.length <= 3);
  assert.equal(sent.join(''), input);
  assert.equal(result.sent, sent.length);
  assert.equal(sent.filter(p => p.includes(url)).length, 1);
  assert.equal(sent.filter(p => p.includes(cq)).length, 1);
});

test('发送结果未知时停止后续分段且不重发', async () => {
  const h = new Humanizer({ enabled: false });
  const input = '无标点长内容'.repeat(300);
  const attempts = [];
  const result = await h.say(input, { send: async p => { attempts.push(p); return attempts.length === 1 ? {ok:true} : {ok:true,outcome:'unknown'}; } });
  assert.equal(result.ok, false);
  assert.equal(result.sent, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts.join(''), input.slice(0, attempts.join('').length));
});

test('长段不会因模拟错字而篡改', async () => {
  const h = new Humanizer({ typoRate: 1 });
  const input = '这是的长段说明'.repeat(300);
  const sent = [];
  await h.say(input, { send: async p => { sent.push(p); return {ok:true}; }, sleep: async () => {} });
  assert.equal(sent.join(''), input);
});
