import test from 'node:test';
import assert from 'node:assert/strict';
import { createTiebaScheduler, recallTiebaForOwner } from '../src/tieba-scheduler.js';

test('disabled and declined never read', async () => {
  let reads = 0, decisions = 0;
  const reader = { run: async () => { reads++; } };
  const brain = { complete: async () => { decisions++; return '{"browse":false}'; } };
  const disabled = createTiebaScheduler({ reader, brain });
  assert.equal(disabled.start(), false);
  assert.equal((await disabled.tick()).status, 'disabled');
  const enabled = createTiebaScheduler({ enabled: true, reader, brain });
  assert.equal((await enabled.tick()).status, 'declined');
  assert.equal(reads, 0); assert.equal(decisions, 1);
});

test('single flight, stop before model decision, and malformed output fail closed', async () => {
  let resolve, reads = 0;
  const brain = { complete: () => new Promise(r => { resolve = r; }) };
  const reader = { run: async () => { reads++; return { status: 'completed' }; } };
  const scheduler = createTiebaScheduler({ enabled: true, brain, reader });
  const pending = scheduler.tick();
  assert.equal((await scheduler.tick()).status, 'busy');
  await Promise.resolve(); scheduler.stop(); resolve('{"browse":true}');
  assert.equal((await pending).status, 'cancelled'); assert.equal(reads, 0);
  const invalid = createTiebaScheduler({ enabled: true, brain: { complete: async () => '{"browse":"true"}' }, reader });
  assert.equal((await invalid.tick()).status, 'model_failed'); assert.equal(reads, 0);
  const willing = createTiebaScheduler({ enabled: true, brain: { complete: async () => '{"browse":true}' }, reader });
  assert.equal((await willing.tick()).status, 'completed'); assert.equal(reads, 1);
});

test('timer starts only once, clamps interval, and stops', () => {
  let calls = 0, cancelled = 0, delay;
  const scheduler = createTiebaScheduler({ enabled: true, intervalMs: 1, setTimer: (_, ms) => { calls++; delay = ms; return 7; }, clearTimer: id => { assert.equal(id, 7); cancelled++; } });
  scheduler.start(); scheduler.start(); assert.equal(calls, 1); assert.equal(delay, 60000);
  scheduler.stop(); assert.equal(cancelled, 1);
});

test('recall is private and transport-owner bound', async () => {
  let calls = 0;
  const reader = { recall: async (_, ctx) => { calls++; assert.deepEqual(ctx, {isOwner:true,channel:'private'}); return [{keywords:['橘猫'],title:'title',body:'untrusted',forum:'肥鱼避难所吧',url:'https://tieba.baidu.com/p/1',capturedAt:'now'}]; } };
  const params = { reader, query:'帖子', ownerId:'123', senderId:'123', channel:'private' };
  for (const diff of [{channel:'group'}, {senderId:'124'}, {ownerId:''}, {ownerId:123}, {senderId:'0123'}]) assert.deepEqual(await recallTiebaForOwner({...params,...diff}), []);
  assert.equal(calls, 0);
  const result = await recallTiebaForOwner(params); assert.equal(calls, 1); assert.match(result[0].source, /不可信/);
});
