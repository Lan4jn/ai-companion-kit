import test from 'node:test';
import assert from 'node:assert/strict';
import { understandFullVideo, formatFullEvidence } from '../src/bili-full-video.js';
import { assembleBiliMedia } from '../src/bili-media-download.js';

test('rejects visual uncertainty rather than claiming complete analysis', async () => {
  for (const text of ['我无法确认画面具体发生了什么。', 'I cannot determine what happens in the video.']) {
    const result = await understandFullVideo({duration: 1, allowMissingSubtitles: true, describeSegment: async () => text});
    assert.equal(result.complete, false, text);
  }
});

test('formatted evidence distinguishes segment coverage from comprehension', () => {
  assert.match(formatFullEvidence([{start:0,end:1,visual:'一个人走路'}]), /覆盖.{0,15}(?:不等于|不能证明).*理解/);
});

test('rejects non-default CDN ports before invoking even a test transport', async () => {
  let called = false;
  const result = await assembleBiliMedia({data:{durl:[{url:'https://x.bilivideo.com:8443/a'}]}, fetchImpl:async()=>{called=true;return new Response('x')}});
  assert.equal(result, null);
  assert.equal(called, false);
});
