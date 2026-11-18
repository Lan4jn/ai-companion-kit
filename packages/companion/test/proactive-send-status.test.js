import test from 'node:test';
import assert from 'node:assert/strict';
import { startProactive, stopProactive, getProactiveStatus } from '../src/proactive.js';
import { loopGuard } from '../src/loop-guard.js';

async function run(send, human) {
  const key = 'private:proactive-test';
  loopGuard.reset(key);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = [];
  globalThis.setTimeout = fn => { timers.push(fn); return fn; };
  globalThis.clearTimeout = () => {};
  const turns = [];
  const before = getProactiveStatus().lastSpokeAt;
  try {
    startProactive({
      ownerId: 'proactive-test', activeStart: 0, activeEnd: 0,
      brain: { reply: async () => ({ text: JSON.stringify({ want: true, text: '你好呀' }) }) },
      memory: { sessionTurns: () => [], logTurn: turn => turns.push(turn) },
      bot: { send }, human, initialDelayMs: 0,
    });
    await timers.shift()();
    return { before, after: getProactiveStatus().lastSpokeAt, turns, guard: loopGuard.count(key) };
  } finally {
    stopProactive();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    loopGuard.reset(key);
  }
}

test('confirmed transport failure does not record proactive delivery or consume guard queue', async () => {
  const result = await run(async () => ({ ok: false, outcome: 'retry', error: 'offline' }));
  assert.equal(result.after, result.before);
  assert.deepEqual(result.turns, []);
  assert.equal(result.guard, 0);
});

test('blocked transport leaves state unchanged', async () => {
  const result = await run(async () => ({ ok: true, blocked: true }));
  assert.equal(result.after, result.before);
  assert.deepEqual(result.turns, []);
  assert.equal(result.guard, 0);
});

test('ambiguous or thrown transport failure keeps a temporary guard entry', async () => {
  for (const send of [async () => ({ ok: false, error: 'offline' }), async () => { throw new Error('offline'); }]) {
    const result = await run(send);
    assert.equal(result.after, result.before);
    assert.deepEqual(result.turns, []);
    assert.equal(result.guard, 1);
  }
});

test('humanized failure before delivery leaves state unchanged', async () => {
  const human = { say: async (text, { send }) => { await send(text); } };
  const result = await run(async () => ({ ok: false, outcome: 'permanent' }), human);
  assert.equal(result.after, result.before);
  assert.deepEqual(result.turns, []);
  assert.equal(result.guard, 0);
});

test('partial humanized delivery records only delivered parts', async () => {
  let calls = 0;
  const human = { say: async (text, { send }) => { await send('你好'); await send('呀'); } };
  const result = await run(async () => (++calls === 1 ? { ok: true } : { ok: false }), human);
  assert.notEqual(result.after, null);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].text, '你好');
  assert.equal(result.guard, 1);
});

test('successful direct delivery records the message', async () => {
  const result = await run(async () => ({ ok: true }));
  assert.notEqual(result.after, null);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].text, '你好呀');
  assert.equal(result.guard, 1);
});

test('unknown delivery is not retried within a humanized activity, but later independent activity can send', async () => {
  const key = 'private:proactive-unknown-test';
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalNow = Date.now;
  const timers = [];
  let now = originalNow();
  let calls = 0;
  let attempts = 0;
  const turns = [];
  loopGuard.reset(key);
  globalThis.setTimeout = fn => { timers.push(fn); return fn; };
  globalThis.clearTimeout = () => {};
  Date.now = () => now;
  try {
    startProactive({
      ownerId: 'proactive-unknown-test', activeStart: 0, activeEnd: 0,
      brain: { reply: async () => ({ text: JSON.stringify({ want: true, text: '你好呀' }) }) },
      memory: { sessionTurns: () => [], logTurn: turn => turns.push(turn) },
      bot: { send: async () => (++calls === 1 ? { ok: false, outcome: 'unknown' } : { ok: true }) },
      human: { say: async (text, { send }) => {
        attempts++;
        try { await send(text); } catch {}
        if (attempts === 1) {
          try { await send(text); } catch {}
        }
      } },
      initialDelayMs: 0,
    });
    await timers.shift()();
    assert.equal(calls, 1);
    assert.equal(turns.length, 0);
    assert.equal(loopGuard.count(key), 1);
    now += loopGuard.windowMs + 1;
    await timers.shift()();
    assert.equal(calls, 2);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].text, '你好呀');
  } finally {
    await stopProactive();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalNow;
    loopGuard.reset(key);
  }
});
