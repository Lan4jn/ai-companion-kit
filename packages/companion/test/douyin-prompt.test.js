import test from 'node:test';
import assert from 'node:assert/strict';
import { Role } from '../src/role.js';
import { generateDouyinComment } from '../src/douyin-living.js';

test('public Douyin comments use isolated completion and explicit decision', async () => {
  let input;
  const text = await generateDouyinComment({ complete: async (value) => { input = value; return '{"comment":true,"text":"挺有意思"}'; } }, { title: '视频', author: '作者', topComments: [] });
  assert.equal(text, '挺有意思');
  assert.equal(input.json, true);
  assert.match(input.system, /跳过/);
  assert.match(input.prompt, /视频/);
});

test('public role rules omit QQ mention syntax while QQ keeps it', () => {
  const role = new Role();
  assert.doesNotMatch(role.build({ platformKind: 'douyin-public' }), /\[CQ:at,qq=/);
  assert.match(role.build(), /\[CQ:at,qq=/);
});
