import test from 'node:test';
import assert from 'node:assert/strict';
import { runHongguoCycle, createHongguoScheduler } from '../src/hongguo-autonomous.js';

test('手动调度按时间限流且不允许并发', async () => {
  let now = 1000, resolveDecision, calls = 0;
  const scheduler = createHongguoScheduler({ intervalMs: 100, now: () => now });
  const opts = { permission: true, brain: { complete: () => { calls++; return new Promise(resolve => { resolveDecision = resolve; }); } } };
  const first = scheduler.tick(opts);
  assert.equal((await scheduler.tick(opts)).status, 'busy');
  await Promise.resolve();
  resolveDecision('{"want":false}');
  assert.equal((await first).status, 'skipped');
  assert.equal((await scheduler.tick(opts)).status, 'not_due');
  now += 100;
  assert.equal((await scheduler.tick({ permission: false })).status, 'permission_required');
  assert.equal(calls, 1);
});

test('没有明确许可时不询问模型也不观测', async () => {
  let calls = 0;
  const result = await runHongguoCycle({ brain: { complete: async () => { calls++; } }, observation: { capture: async () => { calls++; } } });
  assert.equal(result.status, 'permission_required');
  assert.equal(calls, 0);
});

test('模型选择跳过时不观测', async () => {
  let captures = 0;
  const result = await runHongguoCycle({ permission: true, brain: { complete: async () => '{"want":false}' }, observation: { capture: async () => { captures++; } } });
  assert.equal(result.status, 'skipped');
  assert.equal(captures, 0);
});

test('模型愿意观看后须通过同集进度和画面证据', async () => {
  let n = 0;
  const result = await runHongguoCycle({ permission: true, brain: { complete: async () => '{"want":true}' }, observation: {
    serial: 's', packageName: 'p', wait: async () => {}, recognize: async () => ['屏幕文字'],
    capture: async () => ({ serial: 's', packageName: 'p', state: 'playing', capturedAt: ++n, image: Buffer.from(String(n)), episodeId: 'ep1', positionMs: n * 1000 }),
  } });
  assert.equal(result.status, 'verified');
  assert.equal(result.assessment.verified, true);
});

test('同集进度不成立时不得报告观看', async () => {
  let n = 0;
  const result = await runHongguoCycle({ permission: true, brain: { complete: async () => '{"want":true}' }, observation: {
    serial: 's', packageName: 'p', wait: async () => {}, recognize: async () => ['屏幕文字'],
    capture: async () => ({ serial: 's', packageName: 'p', state: 'playing', capturedAt: ++n, image: Buffer.from(String(n)), episodeId: String(n), positionMs: n * 1000 }),
  } });
  assert.equal(result.status, 'unverified');
  assert.equal(result.assessment.verified, false);
});

test('模型错误或无效回答时不观测、不虚构决定', async () => {
  for (const complete of [async () => { throw Error('offline'); }, async () => 'yes', async () => '{"want":"true"}']) {
    let calls = 0;
    const result = await runHongguoCycle({ permission: true, brain: { complete }, observation: { capture: async () => { calls++; } } });
    assert.equal(result.status, 'decision_unavailable');
    assert.equal(calls, 0);
  }
});
