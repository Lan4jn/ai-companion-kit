import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug } from '../src/bili-living.js';

test('only subtitles or analyzed frames establish actual video-content evidence', () => {
  assert.equal(__debug.classifyVideoEvidence({ danmaku: '哈哈', comments: '好看' }), 'discussion_only');
  assert.equal(__debug.classifyVideoEvidence({}), 'metadata_only');
  assert.equal(__debug.classifyVideoEvidence({ subtitle: '内容' }), 'content_excerpt');
  assert.equal(__debug.classifyVideoEvidence({ visual: '画面' }), 'content_excerpt');
});


test('playback is counted only when browser reports positive finite progress', () => {
  for (const result of [null, { ok: false, watched: 10 }, { ok: true, watched: 0 }, { ok: true, watched: Infinity }, { ok: true, watched: '30' }]) {
    assert.equal(__debug.hasPlaybackEvidence(result), false);
  }
  assert.equal(__debug.hasPlaybackEvidence({ ok: true, watched: 10 }), true);
});


test('diary rejects unsupported completion claims', () => {
  assert.equal(__debug.safeExcerptMood('我看完了整个视频，好有趣', '标题'), '播放了《标题》的一段，读到部分素材');
  assert.equal(__debug.safeExcerptMood('字幕片段提到了种菜', '标题'), '字幕片段提到了种菜');
});
