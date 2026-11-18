import {test} from 'node:test';import assert from 'node:assert/strict';import {chatLengthGuidance} from '../src/chat-length-guidance.js';
test('群聊闲聊默认短但认真问题可展开',()=>{const s=chatLengthGuidance(true);assert.match(s,/闲聊.*一两句/);assert.match(s,/认真.*解释/);assert.doesNotMatch(s,/必须.*\d+字/)});
test('私聊也自然简短且允许完整回答',()=>{const s=chatLengthGuidance(false);assert.match(s,/闲聊.*一两句/);assert.match(s,/认真.*解释/);assert.match(s,/不要为简短省略.*关键信息/);assert.match(s,/不必刻意续话/)});

test('根据语义自主换行分条，不机械刷屏', () => {
  for (const isGroup of [true, false]) {
    const s = chatLengthGuidance(isGroup);
    assert.match(s, /按语义.*换行/);
    assert.match(s, /一条.*两三条/);
    assert.match(s, /每行.*一条/);
    assert.match(s, /不.*固定概率.*字数/);
    assert.match(s, /不.*逐句.*分条/);
    assert.match(s, /不.*连续轰炸/);
  }
});
