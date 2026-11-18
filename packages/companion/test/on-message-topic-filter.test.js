import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Waker } from '../src/wake.js';
import { TopicFocusTracker } from '../src/topic-focus.js';

// Exercise the actual OneBot callback without starting the service or sending messages.
function harness({ shuttingDown = false } = {}) {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('    onMessage: (msg) => {');
  const end = source.indexOf('\n    },\n  });', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start + '    onMessage: (msg) => {'.length, end);
  const tracker = new TopicFocusTracker({ microCooldownMs: 0 });
  const waker = new Waker({ names: ['小鱼'], ownerIds: ['dad'], probability: 0, topicTracker: tracker });
  const key = 'group:test';
  tracker.startFocus(key, { topic: '游戏', category: 'gaming', keywords: ['云顶'] }, { userId: 'a' });
  waker.setConfig(key, { probability: 0 });
  const pending = new Map(), activeFollowupWindows = new Map();
  const directPendingBatches = new Map();
  const batchQueue = { add(batchKey, msg) { waker.batch(msg, batchKey); pending.set(batchKey, {}); } };
  const cfg = { ownerIds: ['dad'], wake: { groupWindowMs: 2200 }, dataDir: '/nonexistent' };
  const noop = () => {};
  const deps = { shuttingDown, cfg, waker, pending, activeFollowupWindows, directPendingBatches, batchQueue, groupStore: null,
    bot: { syncGroupMembers: async () => ({}), selfId: 'bot' },
    memory: { logGroupChatter: noop, touchSeen: noop }, observeIncoming: noop,
    chatterLearner: { feed: noop }, collectStickers: async () => ({}), recentGroupImages: new Map(),
    respectGuard: { handleIncoming: () => ({ blocked: false }) },
    applyVirtueText: noop, path: { join: () => '' }, appendBridgeLog: noop,
    rel: { observe: noop, verdict: () => 'ok' },
    setTimeout: () => ({}), clearTimeout: noop, console: { log: noop }, Date };
  const callback = new Function(...Object.keys(deps), 'msg', body).bind(null, ...Object.values(deps));
  const send = (text, extra = {}) => callback({ key, groupId: 'test', userId: 'a', name: 'A', isGroup: true, text, ...extra });
  return { send, waker, key, pending, activeFollowupWindows, directPendingBatches, tracker };
}

test('停机中的入口拒绝消息且不创建待合并批次', () => {
  const h = harness({ shuttingDown: true });
  h.send('小鱼你好', { isAtMe: true });
  assert.deepEqual(h.waker.flush(`${h.key}:a`), []);
  assert.equal(h.pending.size, 0);
  assert.equal(h.activeFollowupWindows.size, 0);
  assert.equal(h.directPendingBatches.size, 0);
});

test('话题主动唤醒后的跟聊窗口不能绕过无关话题过滤', () => {
  const h = harness();
  h.send('小鱼你好', { userId: 'other', isAtMe: true });
  h.activeFollowupWindows.set(`${h.key}:a`, Date.now() + 15000);
  h.send('晚饭火锅真好吃');
  assert.deepEqual(h.waker.flush(`${h.key}:a`), []);
});

test('明确@后的输入追加即使与话题无关也合并', () => {
  const h = harness();
  h.send('', { isAtMe: true });
  h.send('晚饭火锅真好吃');
  assert.deepEqual(h.waker.flush(`${h.key}:a`).map(m => m.text), ['', '晚饭火锅真好吃']);
});

test('非直接唤醒的待合并窗口不放行无关消息', (t) => {
  t.mock.method(Date.prototype, 'getHours', () => 12);
  const h = harness();
  h.waker.getConfig(h.key).topicInterestProbability = 1;
  h.send('云顶这个阵容挺有意思');
  h.send('晚饭火锅真好吃');
  assert.deepEqual(h.waker.flush(`${h.key}:a`).map(m => m.text), ['云顶这个阵容挺有意思']);
});

test('话题锁内主人和@仍然优先', () => {
  const h = harness();
  h.send('晚饭火锅', { userId: 'dad' });
  h.send('晚饭火锅', { userId: 'b', isAtMe: true });
  assert.equal(h.waker.flush(`${h.key}:dad`).length, 1);
  assert.equal(h.waker.flush(`${h.key}:b`).length, 1);
});

test('直接批次不串入其他用户与纯分享卡片', () => {
  const h = harness();
  h.send('小鱼你好', { isAtMe: true });
  h.send('晚饭火锅', { userId: 'b' });
  h.send('分享', { isPureShareCard: true });
  assert.deepEqual(h.waker.flush(`${h.key}:a`).map(m => m.text), ['小鱼你好']);
  assert.deepEqual(h.waker.flush(`${h.key}:b`), []);
});
