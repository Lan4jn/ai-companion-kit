import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmptyPublicFishCliche } from '../src/public-comment-naturalness.js';
import { generateDouyinComment, submitDouyinComment, sendDouyinCommentOnce } from '../src/douyin-living.js';

test('only whole empty acknowledgement is blocked, not quotation or concrete context', () => {
  for (const s of ['这条我认', '我接住了！', '这话我记下了。']) assert.equal(isEmptyPublicFishCliche(s), true, s);
  for (const s of ['我接住了掉下来的杯子', '我记下了视频里的配方', '“这条我认”是句套话', '不是铜的，是铝的', '行', '这条我认，第二个镜头拍得好']) assert.equal(isEmptyPublicFishCliche(s), false, s);
});

test('public generation is isolated, evidence-scoped and guided', async () => {
  let request;
  const brain = { complete: async r => { request = r; return JSON.stringify({ comment: true, text: '第二个镜头拍得好' }); } };
  assert.equal(await generateDouyinComment(brain, { title: '镜头', privateSecret: 'NEVER_SEND' }), '第二个镜头拍得好');
  assert.match(request.system, /公开素材/);
  assert.match(request.system, /刻意对仗/);
  assert.doesNotMatch(request.prompt, /NEVER_SEND/);
});

test('gate blocks before transport; valid comments retain privacy checks', async () => {
  let calls = 0;
  const send = async () => { calls++; return { status: 'unknown' }; };
  assert.equal(await submitDouyinComment('这条我认', ['123456789'], send), false);
  assert.equal(await submitDouyinComment('第二个镜头拍得好', [], send), false);
  assert.equal(await submitDouyinComment('QQ 123456789', ['123456789'], send), false);
  assert.equal(calls, 0);
  assert.deepEqual(await sendDouyinCommentOnce({}, { text: '我接住了！', workId: '123', dataDir: '/nonexistent' }), { status: 'failed' });
  assert.deepEqual(await submitDouyinComment('第二个镜头拍得好', ['123456789'], send), { status: 'unknown' });
  assert.equal(calls, 1);
});
