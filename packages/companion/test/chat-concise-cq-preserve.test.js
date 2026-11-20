import test from 'node:test';
import assert from 'node:assert/strict';
import { safeReplyParts, prepareConciseReply } from '../src/chat-concise-delivery.js';

test('CQ 码不占正文码点预算，但超长 CQ 照样拒绝', () => {
  const prose = '鱼'.repeat(50);
  assert.equal(safeReplyParts([prose + '[CQ:face,id=14]']), true);
  assert.equal(safeReplyParts([prose + '鱼']), false);
  // 纯图片气泡（表情包/画图）单独成条时放行：base64 是投递指令，不是正文
  assert.equal(safeReplyParts(['[CQ:image,file=base64://' + 'x'.repeat(60) + ']']), true);
  // 文字+图片同条气泡是合法投递（"给你看"+图），只按文字算长度
  assert.equal(safeReplyParts(['鱼'.repeat(10) + '[CQ:image,file=base64://' + 'x'.repeat(60) + ']']), true);
  // 但假图（没有真实来源的 payload）仍然拒绝
  assert.equal(safeReplyParts(['鱼'.repeat(10) + '[CQ:image,file=' + 'x'.repeat(60) + ']']), false);
});

test('改写模型丢掉 CQ 也能正常发出：先摘出、通过后贴回最后一段', async () => {
  const draft = '今天刷到一个视频说暗区突围的护甲耐久机制改了，以前修一次能顶两局，现在打两枪就掉一大截，所以评论区全都在骂策划，我看着也挺无语。[CQ:face,id=14]';
  const seenDrafts = [];
  const out = await prepareConciseReply(draft, async (text) => {
    seenDrafts.push(text);
    return '暗区护甲改版，两枪掉一大截，大家都在骂。';
  }, async () => true);
  assert.equal(out.failed, undefined);
  assert.equal(out.parts.length, 1);
  assert.equal(out.parts[0].endsWith('[CQ:face,id=14]'), true);
  // 改写模型看到的是纯文本，不含 CQ
  assert.equal(seenDrafts[0].includes('[CQ:'), false);
});
