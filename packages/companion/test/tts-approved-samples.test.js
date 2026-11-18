import test from 'node:test';
import assert from 'node:assert/strict';
import { fishText } from '../src/tts.js';

// Text-only versions of the approved samples; no audio or external probe files.
const samples = [
  { emotion: 'cry', intensity: 'medium', text: '我真的好难过……那只受伤的小猫，最后还是没有等到救助。让我缓一缓，好吗？', expected: '[sad][sobbing] 我真的好难过……那只受伤的小猫，最后还是没有等到救助。让我缓一缓，好吗？' },
  { emotion: 'cry', intensity: 'strong', text: '我真的好难过……那只受伤的小猫，最后还是没有等到救助。让我缓一缓，好吗？', expected: '[very sad][sobbing] 我真的好难过……那只受伤的小猫，最后还是没有等到救助。让我缓一缓，好吗？' },
  { emotion: 'angry', intensity: 'medium', text: '那个人竟然故意伤害小动物，真的太过分了！我们应该马上找人帮忙，保护好它。', expected: '[angry] 那个人竟然故意伤害小动物，真的太过分了！我们应该马上找人帮忙，保护好它。' },
  { emotion: 'shout', intensity: 'stronger', text: '那个人竟然故意伤害小动物，真的太过分了！我们应该马上找人帮忙，保护好它。', expected: '[extremely angry][shouting] 那个人竟然故意伤害小动物，真的太过分了！我们应该马上找人帮忙，保护好它。' },
];

test('approved sample controls remain available without forcing crying or shouting', () => {
  for (const { emotion, intensity, text, expected } of samples) {
    assert.equal(fishText(text, { emotion, intensity }), expected);
  }
  assert.equal(fishText('测试', {emotion:'sad',intensity:'medium'}), '[sad] 测试');
  assert.equal(fishText('测试', {emotion:'angry',intensity:'stronger'}), '[extremely angry] 测试');
});
