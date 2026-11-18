import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatLengthGuidance } from '../src/chat-length-guidance.js';

test('生成指导具体避免对联腔，同时保留完整说明', () => {
  for (const group of [true, false]) {
    const guidance = chatLengthGuidance(group);
    assert.match(guidance, /对仗/);
    assert.match(guidance, /不必.*两句/);
    assert.match(guidance, /具体/);
    assert.match(guidance, /不截断/);
    assert.match(guidance, /认真.*解释清楚/);
  }
});
