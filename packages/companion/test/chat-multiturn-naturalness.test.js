import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatLengthGuidance } from '../src/chat-length-guidance.js';

test('多轮指导关注本会话重复而非固定模板且保留角色与长答', () => {
  for (const isGroup of [false, true]) {
    const prompt = chatLengthGuidance(isGroup);
    assert.match(prompt, /最近.*(?:自己|回复)/);
    assert.match(prompt, /开头/);
    assert.match(prompt, /建议/);
    assert.match(prompt, /口癖/);
    assert.match(prompt, /不是禁止|并非禁止/);
    assert.match(prompt, /人格|个性/);
    assert.match(prompt, /认真.*解释清楚/);
  }
});
