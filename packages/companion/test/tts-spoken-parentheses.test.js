import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEmotionAndCleanText } from '../src/tts.js';

test('spoken parentheticals and factual brackets remain spoken', () => {
  const {cleanText, contextTexts} = extractEmotionAndCleanText('今天（星期五）去看《电影》（2024版），带上[小明]。');
  assert.equal(cleanText, '今天（星期五）去看《电影》（2024版），带上[小明]。');
  assert.deepEqual(contextTexts, []);
});

test('explicit nonverbal emotion tag is removed and becomes guidance', () => {
  const {cleanText, contextTexts} = extractEmotionAndCleanText('[轻笑]你好（小声）');
  assert.equal(cleanText, '你好');
  assert.equal(contextTexts.length, 2);
});
