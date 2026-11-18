import test from 'node:test';
import assert from 'node:assert/strict';
import { assessViewing } from '../src/hongguo-viewing.js';

test('只有有时间进展的真实画面观察才能认定已观看，不能虚构声音', () => {
  const result = assessViewing({ before: { capturedAt: 1000, frameId: 'a', description: '一人在车站', subtitles: ['等我'] }, after: { capturedAt: 2000, frameId: 'b', description: '列车进站', subtitles: ['再见'] }, playbackBefore: { episodeId: 'ep1', positionMs: 100 }, playbackAfter: { episodeId: 'ep1', positionMs: 1100 } });
  assert.equal(result.verified, true);
  assert.deepEqual(result.evidence.subtitles, ['等我', '再见']);
  assert.equal(result.evidence.audio, null);
  assert.match(result.limitations.join(' '), /音频/);
});


test('缺少进度、换集或帧不变都不能认定观看', () => {
  const frame = { capturedAt: 1, frameId: 'a', description: '画面' };
  assert.equal(assessViewing({ before: frame, after: { ...frame, capturedAt: 2 } }).verified, false);
  assert.equal(assessViewing({ before: frame, after: { ...frame, capturedAt: 2, frameId: 'b' }, playbackBefore: { episodeId: '1', positionMs: 0 }, playbackAfter: { episodeId: '2', positionMs: 100 } }).verified, false);
});

test('决策只能根据已核验观察和明确兴趣做出，不执行操作', async () => {
  const { decideNext, updateInterest } = await import('../src/hongguo-viewing.js');
  const memory = updateInterest({}, { topic: '悬疑', preference: '喜欢', source: '用户明确表示' });
  assert.equal(decideNext({ verified: false }, memory, '悬疑').action, 'observe');
  assert.equal(decideNext({ verified: true }, memory, '悬疑').action, 'continue');
  assert.equal(decideNext({ verified: true }, memory, '爱情').action, 'undecided');
  assert.deepEqual(updateInterest(memory, { topic: '爱情', preference: '喜欢', source: '' }), memory);
});
