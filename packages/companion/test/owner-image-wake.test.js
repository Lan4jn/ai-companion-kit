import test from 'node:test';
import assert from 'node:assert/strict';
import { Waker } from '../src/wake.js';
import { TopicFocusTracker } from '../src/topic-focus.js';

const img = { type: 'image', data: { file: 'example.jpg' } };
const base = { key: 'group:test', isGroup: true, text: '[图片]', images: ['example.jpg'], raw: [img] };
const make = (tracker = null) => new Waker({ names: ['小鱼'], ownerIds: ['dad'], probability: 0, topicTracker: tracker });

test('主人群内发图片与普通群友走同一判定，包括锁定和指定发言人', t => {
  t.mock.method(Date.prototype, 'getHours', () => 12);
  for (const locked of [false, true]) {
    const tracker = locked ? new TopicFocusTracker({ microCooldownMs: 0 }) : null;
    if (tracker) tracker.startFocus(base.key, { topic: '游戏', category: 'gaming', keywords: ['云顶'] }, { userId: 'other' });
    const waker = make(tracker);
    waker.setConfig(base.key, { speakerIds: ['dad', 'other'], probability: 0 });
    const owner = waker.shouldWake({ ...base, userId: 'dad', text: '云顶[图片]' });
    const other = waker.shouldWake({ ...base, userId: 'other', text: '云顶[图片]' });
    assert.deepEqual(owner, other);
  }
});

test('主人和群友同时为指定发言人时发图待遇相同', t => {
  t.mock.method(Date.prototype, 'getHours', () => 12);
  const waker = make();
  waker.setConfig(base.key, { speakerIds: ['dad', 'other'], probability: 0 });
  assert.deepEqual(waker.shouldWake({ ...base, userId: 'dad' }), waker.shouldWake({ ...base, userId: 'other' }));
});

test('主人群图明确呼叫、私聊、非图片消息保持原优先', () => {
  const waker = make();
  for (const extra of [{ isAtMe: true }, { isQuoteMe: true }, { text: '小鱼看看[图片]' }, { isPoke: true }]) {
    assert.equal(waker.shouldWake({ ...base, userId: 'dad', ...extra }).wake, true);
  }
  assert.equal(waker.shouldWake({ ...base, key: 'private:dad', isGroup: false, userId: 'dad' }).wake, true);
  assert.equal(waker.shouldWake({ ...base, userId: 'dad', raw: [{type:'text',data:{text:'你好'}}], images: [], text: '你好' }).wake, true);
});

test('引用或转发内图片不把纯文字消息误判为发图', () => {
  const waker = make();
  assert.equal(waker.shouldWake({ ...base, userId: 'dad', raw: [{type:'text',data:{text:'你好'}}], text: '你好' }).reason, 'owner');
});

test('主人图文直接问题与其他群友一样命中问句设置', t => {
  t.mock.method(Date.prototype, 'getHours', () => 12);
  const waker = make();
  waker.setConfig(base.key, { question: true, probability: 0 });
  assert.equal(waker.shouldWake({ ...base, userId: 'dad', text: '这个是什么？[图片]' }).reason, 'question');
});
