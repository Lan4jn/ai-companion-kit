import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFanqieWant } from '../src/fanqie-want.js';

test('模型自主决定想阅读时返回 true，并接收真实上下文', async () => {
  let request;
  const want = createFanqieWant({ brain: { complete: async input => { request = input; return '{"want":true}'; } }, context: async () => '刚聊到科幻小说' });
  assert.equal(await want(), true);
  assert.match(request.prompt, /刚聊到科幻小说/);
  const { createReadingScheduler } = await import('../src/fanqie-scheduler.js');
  let runs = 0;
  const scheduler = createReadingScheduler({ want, run: async () => { runs++; return { ok: true }; } });
  assert.equal((await scheduler.tick()).ok, true);
  assert.equal(runs, 1);
});

test('推理模型有足够 token 预算产生自主决策', async () => {
  let budget;
  const want = createFanqieWant({ brain: { complete: async input => {
    budget = input.max_tokens;
    return budget >= 1000 ? '{"want":true}' : '';
  } } });
  assert.equal(await want(), true);
  assert.ok(budget >= 1000);
});

test('空 JSON 是决策失败而非自主拒绝，不启动阅读', async () => {
  const { createReadingScheduler } = await import('../src/fanqie-scheduler.js');
  let runs = 0;
  const want = createFanqieWant({ brain: { complete: async () => '{}' } });
  const scheduler = createReadingScheduler({ want, run: async () => { runs++; } });
  await assert.rejects(scheduler.tick(), /decision unavailable/);
  assert.equal(runs, 0);
});

test('模型无响应时超时停止调度，不进入阅读', async () => {
  const { createReadingScheduler } = await import('../src/fanqie-scheduler.js');
  let runs = 0;
  const want = createFanqieWant({ brain: { complete: () => new Promise(() => {}) }, timeoutMs: 10 });
  const scheduler = createReadingScheduler({ want, run: async () => { runs++; } });
  await assert.rejects(scheduler.tick(), /decision unavailable/);
  assert.equal(runs, 0);
});

test('上下文超时后即使晚到也不再请求模型', async () => {
  let release, calls = 0;
  const want = createFanqieWant({ brain: { complete: async () => { calls++; return '{"want":true}'; } }, context: () => new Promise(r => { release = r; }), timeoutMs: 10 });
  await assert.rejects(want(), /decision unavailable/);
  release('晚到的上下文');
  await new Promise(r => setImmediate(r));
  assert.equal(calls, 0);
});

test('拒绝、无效结果、离线异常和上下文异常均不启动阅读', async () => {
  const { createReadingScheduler } = await import('../src/fanqie-scheduler.js');
  for (const raw of ['{"want":false}', '{"want":"true"}', '{}', 'not json', '', null]) {
    let runs = 0;
    const want = createFanqieWant({ brain: { complete: async () => raw } });
    const scheduler = createReadingScheduler({ want, run: async () => { runs++; } });
    if (raw === '{"want":false}') assert.equal((await scheduler.tick()).reason, 'not-interested');
    else await assert.rejects(scheduler.tick(), /decision unavailable/);
    assert.equal(runs, 0);
  }
  for (const options of [
    {},
    { brain: { complete: async () => { throw new Error('offline'); } } },
    { brain: { complete: async () => '{"want":true}' }, context: async () => { throw new Error('offline'); } },
  ]) await assert.rejects(createFanqieWant(options)(), /decision unavailable/);
});
