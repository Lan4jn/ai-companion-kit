import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSearchQuery } from '../src/search-privacy.js';

test('ordinary public questions and low-risk public topics are searchable', () => {
  for (const q of ['什么是量子计算？', '怪物猎人荒野最新消息', '法国首都是哪里？']) assert.equal(publicSearchQuery(q), q, q);
});

test('privacy and refusal override public-looking topics', () => {
  for (const q of ['不要搜索怪物猎人荒野', '别帮我查法国首都', '张三的身份证号码是多少', '我的密码是什么', '太阳系 abcdef', '怪物猎人荒野 alice@example.com']) assert.equal(publicSearchQuery(q), '', q);
});
