import test from 'node:test';
import assert from 'node:assert/strict';
import { Waker } from '../src/wake.js';
import { TopicFocusTracker } from '../src/topic-focus.js';

function setup(probability = 0) {
  const tracker = new TopicFocusTracker({ microCooldownMs: 0 });
  const waker = new Waker({ names: ['小鱼'], ownerIds: ['dad'], probability, topicTracker: tracker });
  const key = 'group:test';
  tracker.startFocus(key, { topic: '游戏', category: 'gaming', keywords: ['云顶'] }, { userId: 'a' });
  return { tracker, waker, key };
}
const message = (key, text, extra = {}) => ({ key, text, userId: 'a', isGroup: true, ...extra });

test('话题相关消息不会因锁定而必定插话', () => {
  const { waker, key } = setup(0);
  assert.equal(waker.shouldWake(message(key, '云顶这个阵容挺有意思')).wake, false);
});

test('轮数耗尽仍过滤无关话题，不回落到普通唤醒', () => {
  const { waker, tracker, key } = setup(1);
  tracker.maxTurnsPerFocus = 1;
  waker.shouldWake(message(key, '云顶这个阵容挺有意思'));
  assert.equal(waker.shouldWake(message(key, '晚饭火锅真好吃')).reason, 'topic-lock-ignore-unrelated');
});

test('主人和明确呼叫在冷却及轮数限制下优先', () => {
  const { waker, tracker, key } = setup(0);
  tracker.maxTurnsPerFocus = 1;
  tracker.microCooldownMs = 60000;
  for (const msg of [
    message(key, '晚饭火锅', { userId: 'dad' }),
    message(key, '晚饭火锅', { isAtMe: true }),
    message(key, '晚饭火锅', { isQuoteMe: true }),
    message(key, '小鱼来看看'),
    message(key, '', { isPoke: true }),
  ]) assert.equal(waker.shouldWake(msg).reason, 'topic-priority-override');
});

test('无关消息即使随机概率为一也被过滤', () => {
  const { waker, key } = setup(1);
  assert.equal(waker.shouldWake(message(key, '晚饭火锅真好吃')).reason, 'topic-lock-ignore-unrelated');
});

test('相关话题有机会接话，附和不插话', (t) => {
  t.mock.method(Date.prototype, 'getHours', () => 12);
  const { waker, key } = setup(1);
  assert.equal(waker.shouldWake(message(key, '云顶这个阵容挺有意思')).reason, 'topic-focus:游戏');
  assert.equal(waker.shouldWake(message(key, '确实')).wake, false);
});

test('微冷却期间相关发言延长话题活跃时间', () => {
  const { tracker, key } = setup();
  const lock = tracker.getFocus(key);
  lock.lastActiveAt = Date.now() - 2000;
  tracker.microCooldownMs = 60000;
  const before = lock.lastActiveAt;
  assert.equal(tracker.checkMessage(message(key, '云顶这阵容不错')).reason, 'topic-micro-cooldown');
  assert.ok(lock.lastActiveAt > before);
});
