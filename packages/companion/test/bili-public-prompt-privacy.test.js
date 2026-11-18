import test from 'node:test';
import assert from 'node:assert/strict';
import { __debug } from '../src/bili-living.js';

const video = { title: '测试视频', up: 'UP', duration: 60 };

test('public comment generation excludes owner profile and disables implicit private recall', async () => {
  let input;
  const brain = { reply: async (x) => { input = x; return { text: '{"want":true,"text":"这个片段真的挺有意思"}' }; } };
  assert.ok(await __debug.draftComment(brain, video, '公开视频内容', { ownerProfile: '私人画像绝密标记' }));
  assert.ok(!JSON.stringify(input).includes('私人画像绝密标记'));
  assert.equal(input.trapProbe, true);
  assert.deepEqual(input.history, []);
});

test('public owner mention replies use isolated identity and no private history', async () => {
  let input;
  const brain = { reply: async x => { input = x; return { text: '{"reply":true,"text":"这个太逗了"}' }; } };
  const text = await __debug.draftMentionReply(brain, { isOwner: true, uid: '123', ownerQQ: '456', who: '爸', title: '视频', said: '好看', kind: 'reply', history: [{ text: '私聊秘密' }] });
  assert.equal(text, '这个太逗了');
  assert.equal(input.userId, '__bili_mention__');
  assert.equal(input.key, '__bili_mention__');
  assert.equal(input.trapProbe, true);
  assert.deepEqual(input.history, []);
});

test('a profile-informed reach comment is regenerated using public context', async () => {
  let input;
  const brain = { reply: async x => { input = x; return { text: '{"want":true,"text":"这片段太有意思了"}' }; } };
  const text = await __debug.draftReachComment(brain, video, '公开素材', { ownerName: '爸', ownerProfile: '绝密画像', say: '私聊秘密' });
  assert.equal(text, '这片段太有意思了');
  assert.ok(!JSON.stringify(input).includes('绝密画像'));
  assert.ok(!JSON.stringify(input).includes('私聊秘密'));
  assert.equal(input.trapProbe, true);
});

test('public generation suppresses pre-existing memory for the synthetic identity', async () => {
  let injected;
  const brain = {
    memory: { renderPerson: () => '私人记忆标记' },
    async reply(input) { injected = this.memory.renderPerson(input.userId); return { text: '{"want":true,"text":"这个片段真的挺有意思"}' }; },
  };
  await __debug.draftComment(brain, video, '公开素材');
  assert.equal(injected, '');
});
