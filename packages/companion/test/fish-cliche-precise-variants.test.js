import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasFishCliche } from '../src/fish-cliche.js';

test('detects additional whole-message empty formula variants', () => {
  for (const text of ['这句我记下了。', '这句接住了！', '这话接住了', '这句我接住了', '这话我接住了']) {
    assert.equal(hasFishCliche(text), true, text);
  }
});

test('preserves quotations, code, meaningful context and ordinary replies', () => {
  for (const text of [
    '“这句我记下了。”', '`这句接住了！`', '```text\n这话接住了\n```',
    '这句我记下了，以后不会再给你发语音。', '这句接住了，但我不同意你的结论。',
    '她说这话我接住了，指的是接话的时机。', '这句我接住了，你前一句讲得很有道理。',
    '这话我接住了，后面那句却没听清。', '我记下了视频里的配方。', '好，我知道了。',
    '这句接住了？你确定听清了吗？', '这句接住了？', '这话我接住了？',
  ]) assert.equal(hasFishCliche(text), false, text);
});
