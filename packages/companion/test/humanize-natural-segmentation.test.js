import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Humanizer } from '../src/humanize.js';

test('默认保留短回答和长回答末尾标点及链接', () => {
  const h = new Humanizer();
  for (const input of ['好的。', '请看 https://example.com/a.', '解释：' + '必要内容，'.repeat(40) + '结束。']) {
    assert.equal(h.split(input).join(''), input);
  }
});

test('大量段落及 CQ 图片依次发出，超额合并不丢内容', async () => {
  const h = new Humanizer({ enabled: false, burstMax: 3, stripPeriod: false });
  const input = Array.from({ length: 25 }, (_, i) => i === 8 ? '[CQ:image,file=x.jpg]' : `第${i}段必要说明`).join('\n');
  const sent = [];
  const result = await h.say(input, { send: async part => { sent.push(part); return {ok: true}; } });
  assert.equal(result.sent, sent.length);
  assert.ok(sent.length <= 3);
  assert.equal(sent.join('\n'), input);
});

test('主聊天入口不再以固定字数约束日常或认真回答', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /2~10字极简碎句|2~15字短句|1~10字，老群友|2~10字为主/);
});
