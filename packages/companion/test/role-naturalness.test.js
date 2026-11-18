import test from 'node:test';
import assert from 'node:assert/strict';
import { Role } from '../src/role.js';

const role = new Role({ cardPath: new URL('../role.md', import.meta.url), altCardPath: new URL('../role-sassy.md', import.meta.url), maxChars: 50000 });

for (const sassy of [false, true]) {
  test(`${sassy ? 'sassy' : 'base'} prompt balances natural replies and factual honesty`, () => {
    const prompt = role.build({ sassy });
    assert.match(prompt, /日常聊天通常一两句/);
    assert.match(prompt, /明确询问图片或表情包时/);
    assert.match(prompt, /看不清就如实说/);
    assert.doesNotMatch(prompt, /最高铁律·严禁评价\/点评表情包|绝对禁止评价、复述或报幕表情包|2~10字极简碎句|灵魂「？」起手/);
  });
}

test('public prompt keeps the privacy filter', () => {
  const prompt = role.build({ platformKind: 'douyin-public', sassy: true });
  assert.match(prompt, /公开评论禁止输出QQ号、CQ码或表情包标记/);
  const rules = prompt.split('【完整设定】')[0];
  assert.doesNotMatch(rules, /\[CQ:at,qq=|\[表情包: 情绪\/标签\]/);
});
