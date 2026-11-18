import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Humanizer } from '../src/humanize.js';

test('长单行只在句末分条，保留内容和空格', () => {
  const input = '这是一段认真说明背景和条件的文字，里面有很多重要细节需要完整保留。  接下来还有另一段值得认真阅读的补充，绝不能随意丢掉！最后是给你的建议，希望能帮到你。';
  const parts = new Humanizer({ stripPeriod: false }).split(input);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), input);
  assert.ok(parts[0].includes('。'));
});

test('短消息保持完整，过长单句可在中文逗号自然分段', () => {
  const h = new Humanizer({ stripPeriod: false });
  assert.deepEqual(h.split('今天好吗？我挺好的！'), ['今天好吗？我挺好的！']);
  const input = '这是一句只有逗号的很长的话，'.repeat(12) + '最后完整说完。';
  const parts = h.split(input);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), input);
  assert.ok(parts.slice(0, -1).every(part => part.endsWith('，')));
});

test('长文本遵守 burstMax，不把尾部句子合并成一个过长气泡', () => {
  const h = new Humanizer({ stripPeriod: false, burstMax: 2 });
  const sentence = '这是一些必须保留的解释和背景信息，它们对于理解问题非常重要。';
  const input = sentence.repeat(6);
  const parts = h.split(input);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(''), input);
  assert.equal(parts[0], sentence.repeat(3));
});

test('链接、CQ 码、行内代码和代码块不在内部切开', () => {
  const h = new Humanizer({ stripPeriod: false });
  for (const token of ['https://example.com/a?x=一！二', '[CQ:face,id=123！456]', '`foo！bar`', '```js\nfoo！bar\n```']) {
    const input = `前面有很多需要认真交代的信息和细节，这里的文字只是用来构造一个足够长的回复。${token} 后面还有非常重要的内容，不能丢失。`;
    const parts = h.split(input);
    assert.ok(parts.some(part => part.includes(token)), token);
  }
});

test('私聊 say 和群聊预先 split 再 say 使用相同气泡', async () => {
  const h = new Humanizer({ enabled: false, stripPeriod: false, burstMax: 2 });
  const input = '这是一个很长的说明，里面包含必要的条件和背景，需要你先仔细了解，不要遗漏任何关键信息。接下来还有一个重要的补充，读完之后就可以做出决定了。';
  const direct = [], group = [];
  await h.say(input, { send: async part => direct.push(part) });
  await h.say(h.split(input), { send: async part => group.push(part) });
  assert.ok(direct.length > 1);
  assert.deepEqual(group, direct);
  assert.equal(direct.join(''), input);
});
