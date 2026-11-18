import test from 'node:test';
import assert from 'node:assert/strict';
import { fishText } from '../src/tts.js';

test('Fish emotion categories remain distinct and ordinary sadness or anger do not force crying or shouting', () => {
  const cases = [
    ['natural', 'medium', '你好'],
    ['angry', 'medium', '[angry] 你好'],
    ['sad', 'medium', '[sad] 你好'],
    ['cry', 'medium', '[sad][sobbing] 你好'],
    ['shout', 'stronger', '[extremely angry][shouting] 你好'],
    ['happy', 'medium', '[happy] 你好'],
    ['gentle', 'medium', '[with gentle warmth] 你好'],
  ];
  for (const [emotion, intensity, expected] of cases) {
    assert.equal(fishText('你好', { emotion, intensity }), expected, emotion);
  }
});

test('Fish uses only validated context and natural default', () => {
  assert.equal(fishText('你好（周五）', {}), '你好（周五）');
  assert.equal(fishText('你好', {emotion:'愤怒', intensity:'strong'}), '[very angry] 你好');
  assert.equal(fishText('你好', {emotion:'难过', intensity:'stronger'}), '[extremely sad] 你好');
  assert.equal(fishText('你好', {emotion:'难过', intensity:'mild'}), '[slightly sad] 你好');
  assert.equal(fishText('(angry)你好[crying]', {emotion:'私密内容 angry'}), '你好');
  assert.equal(fishText('你好', {emotion:'愤怒', intensity:'invalid'}), '[slightly angry] 你好');
});
